/**
 * Helpers para ler/setar o remote `origin` do workspace.
 * Compartilhado entre `clone-repo.ts` e `sync.ts` — ambos precisam ler o URL
 * limpo antes de injetar token e re-setar o URL plain depois.
 */

import { runGit } from './clone.js';

export class RemoteUrlError extends Error {
  constructor(message: string, public code: 'GIT_FAILED' | 'TIMEOUT' | 'NO_ORIGIN') {
    super(message);
    this.name = 'RemoteUrlError';
  }
}

/** Lê o URL atual do remote `origin`. Lança RemoteUrlError se não existir. */
export async function getOriginUrl(cwd: string, timeoutMs: number): Promise<string> {
  const r = await runGit(['remote', 'get-url', 'origin'], { cwd, timeoutMs });
  if (!r.ok) {
    if (r.code === 'TIMEOUT') throw new RemoteUrlError(r.message, 'TIMEOUT');
    if (/no such remote|does not exist/i.test(r.message)) {
      throw new RemoteUrlError('origin remote not configured', 'NO_ORIGIN');
    }
    throw new RemoteUrlError(r.message, 'GIT_FAILED');
  }
  return r.stdout.trim();
}

/** Define o URL do remote `origin` (rebaixa erro a RemoteUrlError pra log). */
export async function setRemoteUrl(cwd: string, url: string, timeoutMs: number): Promise<void> {
  const r = await runGit(['remote', 'set-url', 'origin', url], { cwd, timeoutMs });
  if (!r.ok) {
    if (r.code === 'TIMEOUT') throw new RemoteUrlError(r.message, 'TIMEOUT');
    throw new RemoteUrlError(r.message, 'GIT_FAILED');
  }
}
