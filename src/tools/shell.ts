import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { getWorktreePath, resolveSafe } from '../workspace.js';
import { buildCleanEnv } from '../util/env.js';
import { buildBwrapArgs, bwrapAvailable, wrapWithDropPriv } from '../util/sandbox.js';
import { env as appEnv } from '../lib/env.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const okJson = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj) }] });
const errResp = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true });

export function registerShellTool(server: McpServer): void {
  const timeoutSec = Math.round(appEnv.SHELL_RUN_TIMEOUT_MS / 1000);
  const stdoutKb = Math.round(appEnv.SHELL_STDOUT_MAX_BYTES / 1024);
  const stderrKb = Math.round(appEnv.SHELL_STDERR_MAX_BYTES / 1024);
  server.registerTool(
    'run_command',
    {
      description:
        `Executa um comando bash no workspace. Timeout ${timeoutSec}s — use start_process pra comandos longos. Retorna stdout (≤${stdoutKb}KB), stderr (≤${stderrKb}KB), exitCode.`,
      inputSchema: {
        cmd: z.string().describe('Comando bash (ex.: "npm test", "git status")'),
        cwd: z.string().optional().describe('Subdiretório relativo ao workspace'),
      },
    },
    async ({ cmd, cwd }) => {
      try {
        return okJson(await runShellCommand(cmd, cwd));
      } catch (e) {
        return errResp(`run_command falhou: ${(e as Error).message}`);
      }
    },
  );
}

export interface RunOnceResult {
  cmd: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export async function runShellCommand(
  cmd: string,
  cwdOpt?: string,
): Promise<RunOnceResult & { isolated: boolean }> {
  const workDir = cwdOpt ? resolveSafe(cwdOpt) : getWorktreePath();
  const isolated = await bwrapAvailable();
  const result = await runOnce(cmd, workDir, isolated);
  return { ...result, isolated };
}

async function runOnce(cmd: string, workDir: string, isolated: boolean): Promise<RunOnceResult> {
  const env = buildCleanEnv();
  // --norc --noprofile: bash não lê /etc/bash.bashrc nem ~/.bashrc, evitando
  // warnings "Permission denied" quando bwrap não binda esses arquivos.
  const leaf = await wrapWithDropPriv(['bash', '--norc', '--noprofile', '-c', cmd]);
  let bin: string;
  let args: string[];
  if (isolated) {
    bin = 'bwrap';
    args = [...buildBwrapArgs({ cwd: workDir, env }), '--', ...leaf];
  } else {
    bin = leaf[0]!;
    args = leaf.slice(1);
  }
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { cwd: workDir, env });
    // P5: Usar array de chunks + Buffer.concat evita concatenação O(n²)
    // de strings em outputs de build/test grandes.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, appEnv.SHELL_RUN_TIMEOUT_MS);

    const stdoutMax = appEnv.SHELL_STDOUT_MAX_BYTES;
    const stderrMax = appEnv.SHELL_STDERR_MAX_BYTES;

    proc.stdout.on('data', (d: Buffer) => {
      // Cap incremental: para de acumular após o limite
      const currentLen = stdoutChunks.reduce((s, c) => s + c.length, 0);
      if (currentLen < stdoutMax) stdoutChunks.push(d);
    });
    proc.stderr.on('data', (d: Buffer) => {
      const currentLen = stderrChunks.reduce((s, c) => s + c.length, 0);
      if (currentLen < stderrMax) stderrChunks.push(d);
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      const stdoutBuf = Buffer.concat(stdoutChunks);
      const stderrBuf = Buffer.concat(stderrChunks);
      const stdout = stdoutBuf.toString('utf8').slice(0, stdoutMax);
      const stderr = stderrBuf.toString('utf8').slice(0, stderrMax);
      resolve({
        cmd,
        cwd: path.relative(getWorktreePath(), workDir) || '.',
        exitCode: code,
        stdout,
        stderr,
        truncated: stdoutBuf.length > stdoutMax || stderrBuf.length > stderrMax,
        timedOut,
      });
    });
    proc.on('error', (e) => {
      clearTimeout(timeout);
      resolve({
        cmd,
        cwd: workDir,
        exitCode: -1,
        stdout: '',
        stderr: e.message,
        truncated: false,
        timedOut: false,
      });
    });
  });
}
