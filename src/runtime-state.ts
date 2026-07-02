/**
 * Active runtime worktree (Fase 2 — Design A1).
 *
 * Só UM worktree por vez serve os exposed services do projeto (web, api,
 * admin...) nas suas portas configuradas. Esse estado vive em memória do
 * sandbox-agent porque é "qual worktree tá rodando AGORA" — não persiste
 * entre restarts do container.
 *
 * Acessado por:
 *  - tool MCP `make_my_worktree_active` (em tools/processes.ts) — swap
 *    atômico: mata o stack ativo atual, sobe no worktree do chat.
 *  - endpoint REST `GET /runtime/active` (api/routes/runtime.ts) — frontend
 *    consulta pra mostrar o indicador "🟢 rodando" no chat certo.
 *  - endpoint REST `POST /runtime/stop` — para tudo, libera as portas.
 */

export interface ActiveRuntimeState {
  /** Path absoluto do worktree ativo (/wt/<id> ou MAIN_WORKTREE). null = nada rodando. */
  activeWorktreePath: string | null;
  /**
   * ConversationId que está com o runtime. null se for o MAIN_WORKTREE
   * (legacy) ou se nada estiver ativo.
   */
  activeConversationId: string | null;
  /** Map label → processId pros processos rodando atualmente. */
  activeServices: Map<string, string>;
  /** Timestamp do último swap, pra UI mostrar "rodando há X". */
  startedAt: number | null;
}

export const runtimeState: ActiveRuntimeState = {
  activeWorktreePath: null,
  activeConversationId: null,
  activeServices: new Map(),
  startedAt: null,
};

export function isActiveRuntime(worktreePath: string): boolean {
  return runtimeState.activeWorktreePath === worktreePath;
}
