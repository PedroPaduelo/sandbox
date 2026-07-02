/**
 * C-11: contexto de credencial git por-async-context (não global).
 *
 * Antes `withAuthenticatedRemote` setava GIT_CONFIG_* em `process.env` GLOBAL —
 * dois pushes concorrentes (comum com múltiplos chats) se sobrescreviam ou um
 * `finally` apagava o env do outro → AUTH_FAILED intermitente.
 *
 * Agora o env de credencial vive num AsyncLocalStorage: cada chamada de
 * `withAuthenticatedRemote` roda seu `op()` dentro de um store isolado, e os
 * `runGit` mesclam `gitCredEnv()` no env do spawn. Sem estado global, sem race.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const gitCredStore = new AsyncLocalStorage<Record<string, string>>();

/** Env de credencial do contexto async atual (vazio fora de withAuthenticatedRemote). */
export function gitCredEnv(): Record<string, string> {
  return gitCredStore.getStore() ?? {};
}
