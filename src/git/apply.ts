/**
 * Primitiva `git apply` para suportar stage/discard de hunk e linha.
 *
 * Recebe um patch unified-diff no body e roda `git apply` via stdin (`-`),
 * combinando flags `--cached` (apply ao index) e `--reverse` (inverte o
 * sentido do patch — usado para discard sem `--cached` e para unstage hunk
 * com `--cached --reverse`).
 *
 * Importante: não usamos `--check` aqui; queremos o efeito real. Para um
 * "dry run" o frontend pode passar `check: true` futuramente.
 */

import { runGit } from './clone.js';
import { GitApplyError, type GitApplyCode } from './apply-error.js';

function classifyApplyStderr(stderr: string): GitApplyCode {
  if (/not a git repository/i.test(stderr)) return 'NOT_A_REPO';
  if (/corrupt patch|fatal: unrecognized input/i.test(stderr)) return 'PATCH_INVALID';
  if (/does not apply|patch failed|while searching for/i.test(stderr))
    return 'PATCH_DOES_NOT_APPLY';
  return 'GIT_FAILED';
}

export interface ApplyPatchOpts {
  cwd: string;
  patch: string;
  cached?: boolean;
  reverse?: boolean;
  timeoutMs: number;
}

export async function applyPatch(opts: ApplyPatchOpts): Promise<void> {
  if (!opts.patch || opts.patch.trim() === '') {
    throw new GitApplyError('patch is empty', 'PATCH_INVALID');
  }

  // Garante newline final — `git apply` exige patches terminados em '\n'
  // ou recusa com "corrupt patch".
  const patch = opts.patch.endsWith('\n') ? opts.patch : `${opts.patch}\n`;

  const args = ['apply', '--whitespace=nowarn'];
  if (opts.cached) args.push('--cached');
  if (opts.reverse) args.push('--reverse');
  args.push('-'); // lê patch de stdin

  const r = await runGit(args, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    stdin: patch,
  });

  if (r.ok) return;
  if (r.code === 'TIMEOUT') throw new GitApplyError(r.message, 'TIMEOUT');
  throw new GitApplyError(r.message, classifyApplyStderr(r.message));
}
