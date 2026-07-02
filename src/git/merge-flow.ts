/**
 * Merge flow atômico — chat-branch → main (Fase 2 — worktree-feature).
 *
 * Orquestra:
 *   1. assert worktree do chat clean (sem dirty)
 *   2. push origin <chat-branch>            (garante GitHub sincronizado)
 *   3. fetch origin no MAIN_WORKTREE
 *   4. se main local atrás → pull --ff-only
 *   5. checkout main + git merge --no-ff <chat-branch>
 *   6. CONFLITO → retorna { status: 'CONFLICT', files }, deixa main no
 *      estado MERGING pra o user resolver (via UI / agent).
 *   7. limpo → push origin main
 *   8. se push falhou non-FF (alguém pushou main entre 3 e 7) → reset
 *      hard pro origin/main, refaz o ciclo (max 3 tentativas).
 *   9. sucesso → remove worktree + delete branch local (remota fica).
 *
 * NÃO chama nenhum endpoint do app-core — só estado git local. O caller
 * (app-core) é quem atualiza Conversation.mergeStatus/mergedAt/etc.
 */

import { spawn } from 'node:child_process';
import { wrapWithDropPriv } from '../util/sandbox.js';
import { gitCredEnv } from './cred-context.js';
import {
  MAIN_WORKTREE,
  resolveWorktreePath,
} from '../workspace.js';
import { withAuthenticatedRemote } from './remote-auth.js';
import { listConflicts } from './merge.js';

export type MergeFlowStatus = 'MERGED' | 'CONFLICT' | 'DIRTY' | 'FAILED';

export interface MergeFlowResult {
  status: MergeFlowStatus;
  /** Quando status=MERGED: SHA do merge commit. */
  commitSha?: string;
  /** Quando status=CONFLICT: lista de paths em conflito. */
  conflictFiles?: string[];
  /** Quando status=FAILED/DIRTY: mensagem pro user. */
  error?: string;
  /** Tentativas até concluir (1-3). */
  attempts: number;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGit(args: string[], cwd: string, timeoutMs = 30_000): Promise<RunResult> {
  // C-9: roda git como uid 1001 (drop-priv) — antes era root e o `merge --no-ff`
  // deixava objetos/refs root-owned no .git, gerando locks "Permission denied"
  // pro agente (uid 1001) em commits seguintes. Fallback gracioso sem setpriv.
  const [bin, ...binArgs] = await wrapWithDropPriv(['git', ...args]);
  return new Promise((resolve, reject) => {
    const p = spawn(bin, binArgs, {
      cwd,
      env: {
        ...process.env,
        ...gitCredEnv(), // C-11: credencial per-request (não global)
        HOME: '/home/sandbox',
        USER: 'sandbox',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    const t = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('git timeout'));
    }, timeoutMs);
    p.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function isDirty(cwd: string): Promise<boolean> {
  const r = await runGit(['status', '--porcelain=v2'], cwd);
  if (r.code !== 0) return false; // não é repo, mas isso seria filtrado antes
  return r.stdout.trim().length > 0;
}

async function aheadBehind(cwd: string, ref: string): Promise<{ ahead: number; behind: number }> {
  const r = await runGit(['rev-list', '--left-right', '--count', `${ref}...HEAD`], cwd);
  if (r.code !== 0) return { ahead: 0, behind: 0 };
  const [behind, ahead] = r.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10));
  return { ahead: ahead || 0, behind: behind || 0 };
}

async function currentBranch(cwd: string): Promise<string> {
  const r = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return r.stdout.trim();
}

async function revParseHead(cwd: string): Promise<string> {
  const r = await runGit(['rev-parse', 'HEAD'], cwd);
  return r.stdout.trim();
}

export interface GitIdentity {
  name: string;
  email: string;
}

// Sem identity, `git merge --no-ff` falha porque o container não tem user.email/name
// configurado globalmente (mesmo problema que createCommit já resolvia em commit.ts).
// Caller pode passar `author` pra atribuir o merge ao usuário real.
const FALLBACK_IDENTITY: GitIdentity = {
  name: 'Sandbox User',
  email: 'sandbox@nommand.local',
};

function identityArgs(id: GitIdentity): string[] {
  return ['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`];
}

export interface MergeChatBranchToMainOpts {
  conversationId: string;
  branchName: string;
  /** Token GitHub pra push autenticado. Opcional pra repos sem auth. */
  token?: string;
  /** Branch destino do merge. Default "main". */
  targetBranch?: string;
  /** Máximo de tentativas em caso de race (default 3). */
  maxAttempts?: number;
  /** Identity do autor do merge commit. Default: fallback "Sandbox User". */
  author?: GitIdentity;
}

export async function mergeChatBranchToMain(
  opts: MergeChatBranchToMainOpts,
): Promise<MergeFlowResult> {
  const target = opts.targetBranch ?? 'main';
  const maxAttempts = opts.maxAttempts ?? 3;
  const wt = resolveWorktreePath(opts.conversationId);
  const idArgs = identityArgs(opts.author ?? FALLBACK_IDENTITY);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 1. Assert no dirty no worktree do chat
    if (await isDirty(wt)) {
      return {
        status: 'DIRTY',
        error:
          'O worktree do chat tem arquivos não commitados. Commit antes de mergear.',
        attempts: attempt,
      };
    }

    // 2. Push chat branch (best-effort — se não tiver remote, segue)
    try {
      const push1 = await withAuthenticatedRemote(wt, opts.token, () =>
        runGit(['push', '-u', 'origin', opts.branchName], wt, 60_000),
      );
      if (push1.code !== 0) {
        return {
          status: 'FAILED',
          error: `push da branch '${opts.branchName}' falhou: ${push1.stderr.trim()}`,
          attempts: attempt,
        };
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (!/no.*origin|NOT_A_REPO/i.test(msg)) {
        return {
          status: 'FAILED',
          error: `push da branch '${opts.branchName}' falhou: ${msg}`,
          attempts: attempt,
        };
      }
      // sem origin → segue, repo local-only
    }

    // 3. Fetch main
    try {
      const fetch1 = await withAuthenticatedRemote(MAIN_WORKTREE, opts.token, () =>
        runGit(['fetch', 'origin', target], MAIN_WORKTREE, 60_000),
      );
      if (fetch1.code !== 0) {
        return {
          status: 'FAILED',
          error: `fetch origin ${target} falhou: ${fetch1.stderr.trim()}`,
          attempts: attempt,
        };
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (!/no.*origin|NOT_A_REPO/i.test(msg)) {
        return {
          status: 'FAILED',
          error: `fetch origin ${target} falhou: ${msg}`,
          attempts: attempt,
        };
      }
    }

    // 4. checkout main no MAIN_WORKTREE
    const co = await runGit(['checkout', target], MAIN_WORKTREE);
    if (co.code !== 0) {
      return {
        status: 'FAILED',
        error: `checkout ${target} falhou: ${co.stderr.trim()}`,
        attempts: attempt,
      };
    }

    // 5. Pull --ff-only se main local atrás de origin
    const ab = await aheadBehind(MAIN_WORKTREE, `origin/${target}`);
    if (ab.behind > 0) {
      const pull = await runGit(['merge', '--ff-only', `origin/${target}`], MAIN_WORKTREE);
      if (pull.code !== 0) {
        return {
          status: 'FAILED',
          error: `pull --ff-only ${target} falhou (main local divergiu): ${pull.stderr.trim()}`,
          attempts: attempt,
        };
      }
    }

    // 6. Merge chat-branch → main
    // `-c user.*` injeta identity por invocação (merge --no-ff cria commit).
    const merge = await runGit(
      [...idArgs, 'merge', '--no-ff', '-m', `Merge branch '${opts.branchName}'`, opts.branchName],
      MAIN_WORKTREE,
      60_000,
    );
    if (merge.code !== 0) {
      const conflictRe = /CONFLICT|Automatic merge failed/;
      if (conflictRe.test(merge.stdout + merge.stderr)) {
        const files = await listConflicts(MAIN_WORKTREE);
        return {
          status: 'CONFLICT',
          conflictFiles: files,
          attempts: attempt,
        };
      }
      return {
        status: 'FAILED',
        error: `merge falhou: ${merge.stderr.trim() || merge.stdout.trim()}`,
        attempts: attempt,
      };
    }

    // 7. Push main
    let push2: RunResult | undefined;
    try {
      push2 = await withAuthenticatedRemote(MAIN_WORKTREE, opts.token, () =>
        runGit(['push', 'origin', target], MAIN_WORKTREE, 60_000),
      );
    } catch (err) {
      const msg = (err as Error).message;
      if (/no.*origin|NOT_A_REPO/i.test(msg)) {
        // Repo sem remote: merge local foi feito, mas não há onde pushar.
        // Considera MERGED (sandbox = verdade local) — caller decide se loga.
        const commitSha = await revParseHead(MAIN_WORKTREE);
        return { status: 'MERGED', commitSha, attempts: attempt };
      }
      return {
        status: 'FAILED',
        error: `push ${target} falhou: ${msg}`,
        attempts: attempt,
      };
    }

    if (push2.code === 0) {
      const commitSha = await revParseHead(MAIN_WORKTREE);
      return { status: 'MERGED', commitSha, attempts: attempt };
    }

    // 8. Push falhou — non-FF (alguém pushou)? Reset hard e retry.
    if (/non-fast-forward|rejected/i.test(push2.stderr)) {
      await runGit(['reset', '--hard', `origin/${target}`], MAIN_WORKTREE);
      continue;
    }

    return {
      status: 'FAILED',
      error: `push ${target} falhou: ${push2.stderr.trim()}`,
      attempts: attempt,
    };
  }

  return {
    status: 'FAILED',
    error: `merge falhou após ${maxAttempts} tentativas (race contra outros pushes em main)`,
    attempts: maxAttempts,
  };
}

export interface MergeBranchIntoParentOpts {
  /** Subagente: dono da branch de origem (worktree a ser mergeada). */
  conversationId: string;
  /** Branch do subagente (origem do merge). */
  branchName: string;
  /** Branch do pai (destino do merge). */
  targetBranch: string;
  /** Pai: dono da worktree onde `targetBranch` está checada out. */
  targetConversationId: string;
  /** Identity do autor do merge commit. */
  author?: GitIdentity;
}

/**
 * Merge LOCAL de uma branch de subagente na branch do PAI, executado DENTRO
 * da worktree do pai (onde a branch do pai já está checada out).
 *
 * Diferente de `mergeChatBranchToMain`: NÃO faz fetch/push origin (é local —
 * o pai/orquestrador decide depois se manda pra main ou abre PR) e NÃO dá
 * `git checkout` da target numa worktree nova (o que falharia com "already
 * checked out" — uma branch só pode estar numa worktree por vez). Como as
 * worktrees compartilham o mesmo `.git`, o merge enxerga a ref da sub-branch
 * direto.
 */
export async function mergeBranchIntoParent(
  opts: MergeBranchIntoParentOpts,
): Promise<MergeFlowResult> {
  const subWt = resolveWorktreePath(opts.conversationId);
  const parentWt = resolveWorktreePath(opts.targetConversationId);
  const idArgs = identityArgs(opts.author ?? FALLBACK_IDENTITY);

  // 1. O trabalho do subagente tem que estar commitado.
  if (await isDirty(subWt)) {
    return {
      status: 'DIRTY',
      error:
        'O worktree do subagente tem arquivos não commitados. Commit antes de mergear.',
      attempts: 1,
    };
  }

  // 2. A worktree do pai precisa estar na branch alvo (sanidade).
  const pb = await currentBranch(parentWt);
  if (pb !== opts.targetBranch) {
    return {
      status: 'FAILED',
      error: `A worktree do pai está em '${pb}', não em '${opts.targetBranch}' — não dá pra mergear.`,
      attempts: 1,
    };
  }

  // 3. Merge --no-ff da sub-branch DENTRO da worktree do pai. Local, sem push.
  const merge = await runGit(
    [
      ...idArgs,
      'merge',
      '--no-ff',
      '-m',
      `Merge subagent branch '${opts.branchName}' into '${opts.targetBranch}'`,
      opts.branchName,
    ],
    parentWt,
    60_000,
  );
  if (merge.code !== 0) {
    if (/CONFLICT|Automatic merge failed/.test(merge.stdout + merge.stderr)) {
      const files = await listConflicts(parentWt);
      return { status: 'CONFLICT', conflictFiles: files, attempts: 1 };
    }
    // "local changes would be overwritten" → pai com pendências não commitadas.
    if (/local changes.*would be overwritten|overwritten by merge/i.test(merge.stderr)) {
      return {
        status: 'DIRTY',
        error: `A branch do pai ('${opts.targetBranch}') tem alterações não commitadas que colidem com o merge. Commit/descarte na worktree do orquestrador e tente de novo.`,
        attempts: 1,
      };
    }
    return {
      status: 'FAILED',
      error: `merge falhou: ${merge.stderr.trim() || merge.stdout.trim()}`,
      attempts: 1,
    };
  }

  const commitSha = await revParseHead(parentWt);
  return { status: 'MERGED', commitSha, attempts: 1 };
}

/**
 * Cleanup pós-merge bem-sucedido: remove o worktree do chat + apaga branch
 * local. Branch remota fica intocada (histórico).
 */
export async function cleanupAfterMerge(opts: {
  conversationId: string;
  branchName: string;
}): Promise<void> {
  const wt = resolveWorktreePath(opts.conversationId);
  // worktree remove (com force porque a branch acabou de ser mergeada)
  await runGit(['worktree', 'remove', '--force', wt], MAIN_WORKTREE);
  // branch -D local
  await runGit(['branch', '-D', opts.branchName], MAIN_WORKTREE);
}

/**
 * Completa um merge pendente (após user resolver conflitos via UI/agente).
 * Faz `git commit` (commit do merge) e push main.
 */
export async function completeMergePendingPush(opts: {
  conversationId?: string;
  branchName?: string;
  token?: string;
  targetBranch?: string;
  author?: GitIdentity;
}): Promise<MergeFlowResult> {
  const target = opts.targetBranch ?? 'main';
  const idArgs = identityArgs(opts.author ?? FALLBACK_IDENTITY);

  // C-2: valida que o merge em curso no MAIN_WORKTREE é mesmo o desta branch.
  // Sem isso, com 2 chats em CONFLICT, completar o merge "do chat A" podia
  // fechar o merge do chat B que estivesse pendente no main.
  if (opts.branchName) {
    const mergeHead = await runGit(['rev-parse', '--verify', 'MERGE_HEAD'], MAIN_WORKTREE, 10_000);
    if (mergeHead.code !== 0) {
      return { status: 'FAILED', error: 'nenhum merge em curso no main pra completar', attempts: 1 };
    }
    const branchTip = await runGit(['rev-parse', '--verify', opts.branchName], MAIN_WORKTREE, 10_000);
    if (branchTip.code === 0 && branchTip.stdout.trim() !== mergeHead.stdout.trim()) {
      return {
        status: 'FAILED',
        error: `merge em curso no main não corresponde à branch ${opts.branchName} (conflito de chats concorrentes)`,
        attempts: 1,
      };
    }
  }

  // Commit pra fechar o merge (git rejeita se ainda houver conflito).
  // Mesma razão do passo 6 em mergeChatBranchToMain: container sem user.* global.
  const commit = await runGit([...idArgs, 'commit', '--no-edit'], MAIN_WORKTREE, 30_000);
  if (commit.code !== 0) {
    // Se ainda há conflitos não resolvidos, devolve CONFLICT
    if (/unresolved conflicts|fix conflicts/i.test(commit.stderr)) {
      const files = await listConflicts(MAIN_WORKTREE);
      return { status: 'CONFLICT', conflictFiles: files, attempts: 1 };
    }
    return {
      status: 'FAILED',
      error: `commit do merge falhou: ${commit.stderr.trim()}`,
      attempts: 1,
    };
  }

  // Push main
  try {
    const push = await withAuthenticatedRemote(MAIN_WORKTREE, opts.token, () =>
      runGit(['push', 'origin', target], MAIN_WORKTREE, 60_000),
    );
    if (push.code !== 0) {
      return {
        status: 'FAILED',
        error: `push ${target} pós-resolução falhou: ${push.stderr.trim()}`,
        attempts: 1,
      };
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (!/no.*origin|NOT_A_REPO/i.test(msg)) {
      return {
        status: 'FAILED',
        error: `push ${target} pós-resolução falhou: ${msg}`,
        attempts: 1,
      };
    }
    // sem origin → merge local fica, mas branch remota não atualiza
  }

  const commitSha = await revParseHead(MAIN_WORKTREE);
  return { status: 'MERGED', commitSha, attempts: 1 };
}
