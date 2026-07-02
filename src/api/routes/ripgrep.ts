import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { getWorktreePath, resolveSafe } from '../../workspace.js';
import { RipgrepSearchParams, RipgrepResult, RipgrepReplaceParams, RipgrepReplaceResult, RipgrepSearchResponse } from '../schemas/ripgrep.js';
import { ErrorResponse } from '../schemas/common.js';
import type { Static } from '@sinclair/typebox';

type RipgrepResultT = Static<typeof RipgrepResult>;
import { buildCleanEnv } from '../../util/env.js';
import { buildBwrapArgs, bwrapAvailable, wrapWithDropPriv } from '../../util/sandbox.js';
import { env as appEnv } from '../../lib/env.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

async function runRgJson(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const isolated = await bwrapAvailable();
  const cleanEnv = buildCleanEnv();
  const leaf = await wrapWithDropPriv(['rg', ...args]);
  let bin: string;
  let argv: string[];
  if (isolated) {
    bin = 'bwrap';
    argv = [...buildBwrapArgs({ cwd, env: cleanEnv }), '--', ...leaf];
  } else {
    bin = leaf[0]!;
    argv = leaf.slice(1);
  }
  return new Promise((resolve) => {
    const proc = spawn(bin, argv, { cwd, env: cleanEnv, shell: false });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code }));
    proc.on('error', (e) => resolve({ stdout, stderr: e.message, exitCode: -1 }));
  });
}

// Parse ripgrep --json output lines
function parseJsonLines(stdout: string): RipgrepResultT[] {
  const results: RipgrepResultT[] = [];
  for (const raw of stdout.split('\n')) {
    if (!raw.trim() || !raw.startsWith('{')) continue;
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (obj.type !== 'match') continue;
      const data = obj.data as Record<string, unknown>;
      const pathObj = data.path as Record<string, string>;
      const lineNum = data.line_number as number;
      const linesObj = data.lines as Record<string, string>;
      const absOffset = data.absolute_offset as number;
      results.push({
        file: pathObj.text.replace(getWorktreePath() + '/', ''),
        line: lineNum,
        text: linesObj.text,
        absoluteOffset: absOffset,
      });
    } catch {
      // skip malformed
    }
  }
  return results;
}

// ── Routes ───────────────────────────────────────────────────────────────────

const ripgrepRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // POST /api/v1/ripgrep/search
  app.post(
    '/ripgrep/search',
    {
      schema: {
        body: RipgrepSearchParams,
        response: { 200: RipgrepSearchResponse, 400: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req, reply) => {
      const { query, cwd, include, exclude, caseSensitive, regex, maxResults } = req.body;

      if (!query?.trim()) {
        return reply.code(400).send({ error: 'query is required' });
      }

      const workDir = cwd ? resolveSafe(cwd) : getWorktreePath();
      const args = ['--json', '-n', '-C', '3'];
      if (caseSensitive) args.push('--case-sensitive');
      if (regex) args.push('--regex');
      else args.push('--fixed-strings');
      if (maxResults != null) args.push('--max-count', String(maxResults));
      if (include) args.push('--glob', include);
      if (exclude) args.push('--glob', `!${exclude}`);
      args.push(query);

      try {
        const result = await runRgJson(args, workDir);
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          return reply.code(500).send({ error: result.stderr || 'ripgrep execution failed', code: 'ERGEXEC' });
        }
        // exitCode 1 = no matches (not an error)
        const matches = parseJsonLines(result.stdout);
        return reply.send(matches);
      } catch (e) {
        return reply.code(500).send({ error: (e as Error).message, code: 'ERGEXEC' });
      }
    },
  );

  // POST /api/v1/ripgrep/replace
  app.post(
    '/ripgrep/replace',
    {
      schema: {
        body: RipgrepReplaceParams,
        response: { 200: RipgrepReplaceResult, 400: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req, reply) => {
      const { query, replacement, files, cwd, caseSensitive, regex, include, exclude, dryRun } = req.body;

      if (!query?.trim() || replacement === undefined || replacement === null) {
        return reply.code(400).send({ error: 'query and replacement are required' });
      }
      if (!files?.length) {
        return reply.code(400).send({ error: 'files array is required and must be non-empty' });
      }
      // Sanitize: reject null bytes and our delimiter sentinel, enforce max length.
      // `\x01` (SOH) is the delimiter chosen for the perl substitution below — if
      // present in either pattern or replacement, the regex boundary would break.
      if (replacement.includes('\x00') || replacement.includes('\x01')) {
        return reply.code(400).send({ error: 'replacement contains invalid characters' });
      }
      if (query.includes('\x00') || query.includes('\x01')) {
        return reply.code(400).send({ error: 'query contains invalid characters' });
      }
      if (replacement.length > 10_240) {
        return reply.code(400).send({ error: 'replacement too long (max 10KB)' });
      }

      const workDir = cwd ? resolveSafe(cwd) : getWorktreePath();

      // ISSUE-02: every entry in files[] must be validated against the workspace
      // root to prevent path traversal (e.g. "../../etc/passwd").
      const safeFiles: { rel: string; abs: string }[] = [];
      for (const f of files) {
        try {
          // Resolve relative to workDir (which is already safe). Re-validate via
          // resolveSafe to reject inputs that escape the workspace root.
          const abs = resolveSafe(path.isAbsolute(f) ? f : path.join(workDir, f));
          safeFiles.push({ rel: f, abs });
        } catch {
          return reply.code(400).send({ error: `path fora do workspace: ${f}`, code: 'EPATH' });
        }
      }

      // dryRun: just count matches
      if (dryRun) {
        const args = ['--json', '-n'];
        if (caseSensitive) args.push('--case-sensitive');
        if (regex) args.push('--regex');
        else args.push('--fixed-strings');
        if (include) args.push('--glob', include);
        if (exclude) args.push('--glob', `!${exclude}`);
        args.push(query);

        let totalMatches = 0;
        for (const { abs: absPath } of safeFiles) {
          const result = await runRgJson([...args, '--', absPath], workDir);
          totalMatches += parseJsonLines(result.stdout).length;
        }
        return reply.send({ filesModified: 0, files: [], replacements: totalMatches, dryRun: true });
      }

      // Actual replace: use perl -i -pe for safe substitution with a rare
      // delimiter (\x01 SOH) that we reject in inputs above (ISSUE-01). Perl
      // is more predictable than sed across BSD/GNU variants and supports
      // arbitrary single-byte delimiters via the `s<DELIM>...<DELIM>...<DELIM>g`
      // syntax. We pass pattern/replacement via env vars so the regex
      // boundary cannot be confused by shell parsing — `shell: false` is
      // already set, but env passing also keeps newlines/backslashes intact.
      //
      // Pattern construction:
      //  - if regex flag is on: pass query as-is and let perl compile it
      //  - if literal:          wrap with `\Q...\E` so regex metachars are inert
      // Replacement: perl `$ENV{REPL}` interpolates the env var; backslashes,
      // `/`, `$` and `&` in the user-provided replacement are kept literal
      // because they live in the env value, not in the regex/replacement
      // source code. We also disable special variable interpretation by
      // using a plain string interpolation (no `e` flag).
      const perlPattern = regex
        ? '(?:' + query + ')'
        : '\\Q' + query + '\\E';
      // `s\x01<pat>\x01$ENV{REPL}\x01<flags>` — env interpolation keeps the
      // user string literal at the replacement site. Flags: `g` always (replace
      // all on a line), `i` when case-insensitive.
      const perlFlags = caseSensitive ? 'g' : 'gi';
      const perlScript = `s\x01${perlPattern}\x01$ENV{REPL}\x01${perlFlags}`;

      let filesModified = 0;
      const modifiedFiles: string[] = [];
      let replacements = 0;

      for (const { rel: file, abs: absPath } of safeFiles) {
        // Count matches first
        const countArgs = ['--json', '-n', '--count-matches'];
        if (caseSensitive) countArgs.push('--case-sensitive');
        if (regex) countArgs.push('--regex');
        else countArgs.push('--fixed-strings');
        if (include) countArgs.push('--glob', include);
        if (exclude) countArgs.push('--glob', `!${exclude}`);
        countArgs.push(query);
        const countResult = await runRgJson([...countArgs, '--', absPath], workDir);
        const countMatches = parseJsonLines(countResult.stdout).length;
        if (countMatches === 0) continue;
        // Run perl -i -pe. `-CSD` makes IO/argv assume UTF-8.
        const perlArgs = ['-i', '-CSD', '-pe', perlScript, absPath];
        const perlEnv = { ...buildCleanEnv(), REPL: replacement };
        const perlResult = await new Promise<{ exitCode: number | null; stderr: string }>((resolve) => {
          const proc = spawn('perl', perlArgs, { cwd: workDir, env: perlEnv, shell: false });
          let stderr = '';
          proc.stderr.on('data', (d) => (stderr += d.toString()));
          proc.on('close', (code) => resolve({ exitCode: code, stderr }));
          proc.on('error', (e) => resolve({ exitCode: -1, stderr: e.message }));
        });
        if (perlResult.exitCode === 0) {
          filesModified += 1;
          modifiedFiles.push(file);
          replacements += countMatches;
        } else {
          app.log.warn({ file, stderr: perlResult.stderr }, 'perl replace failed');
        }
      }

      return reply.send({ filesModified, files: modifiedFiles, replacements, dryRun: false });
    },
  );
};

export default ripgrepRoutes;