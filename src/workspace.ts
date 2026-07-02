import path from 'node:path';
import fs from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { env } from './lib/env.js';

// ── Worktree model (Fase 2) ────────────────────────────────────────────
//
// `MAIN_WORKTREE` é o diretório histórico (`/workspace`) — agora oficialmente
// o worktree da branch main do projeto. Operações "globais" (fetch/pull do
// main, merge da chat-branch pra main) operam aqui.
//
// `WORKTREES_BASE` (`/wt`) é onde nascem worktrees por-chat:
// `/wt/<conversationId>` é o worktree da branch daquele chat.
//
// Propagação de contexto: o motor injeta o header `X-Sandbox-Worktree:
// <conversationId>` no MCP fetch (e o frontend faz o mesmo nas REST calls
// que operam num chat específico). O hook em `bootstrap/plugins.ts` lê o
// header e empilha o path resolvido via `AsyncLocalStorage`. Tools/routes
// chamam `getWorktreePath()` em vez de assumir `MAIN_WORKTREE`.
//
// Quando o header está ausente (chat legacy, op global, ferramenta admin),
// `getWorktreePath()` cai pra `MAIN_WORKTREE` — backwards-compat.

export const MAIN_WORKTREE = env.workspace;
export const WORKTREES_BASE = '/wt';
export const SANDBOX_HOME = '/home/sandbox';
export const SANDBOX_UID = 1001;
export const SANDBOX_GID = 1001;

/** Alias histórico — código antigo continua importando `WORKSPACE_ROOT`. */
export const WORKSPACE_ROOT = MAIN_WORKTREE;

interface WorktreeContext {
  /** Path absoluto do worktree desta request. */
  worktreePath: string;
  /** conversationId que originou esse contexto (debug/log). Null em legacy. */
  conversationId?: string;
}

const worktreeStorage = new AsyncLocalStorage<WorktreeContext>();

/**
 * Roda `fn` com o worktree empilhado no contexto async. Tudo que `fn` dispara
 * (incluindo awaits encadeados) enxerga esse worktree via `getWorktreePath()`.
 */
export function runWithWorktreeContext<T>(
  ctx: WorktreeContext,
  fn: () => T,
): T {
  return worktreeStorage.run(ctx, fn);
}

/**
 * Versão "sem callback" — empilha o contexto na async resource ATUAL e tudo
 * que vier depois (no mesmo chain async) enxerga via `getWorktreePath()`.
 * Usado pelo Fastify `onRequest` hook, onde não dá pra envolver o handler
 * num callback (o handler roda fora do hook).
 *
 * Cada request começa com store fresh, então não há leak entre requests.
 */
export function enterWorktreeContext(ctx: WorktreeContext): void {
  worktreeStorage.enterWith(ctx);
}

/**
 * Path do worktree ativo no contexto async, ou `MAIN_WORKTREE` se nenhum.
 * Esse é o ponto de troca pra que tools/routes operem no worktree do chat
 * sem precisar passar o path explicitamente.
 */
export function getWorktreePath(): string {
  return worktreeStorage.getStore()?.worktreePath ?? MAIN_WORKTREE;
}

/** Mesmo que `getWorktreePath`, mas retorna `null` se nenhum contexto setado. */
export function getCurrentWorktreeContext(): WorktreeContext | undefined {
  return worktreeStorage.getStore();
}

/**
 * Resolve `/wt/<conversationId>`. NÃO checa existência — caller decide.
 */
export function resolveWorktreePath(conversationId: string): string {
  // conversationId é um cuid/uuid validado a montante; sanitização defensiva
  // pra impedir `..` ou separadores escaparem do WORKTREES_BASE.
  const safe = conversationId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe || safe !== conversationId) {
    throw new Error(`conversationId inválido: ${conversationId}`);
  }
  return path.join(WORKTREES_BASE, safe);
}

export async function ensureWorkspace(): Promise<void> {
  await fs.mkdir(MAIN_WORKTREE, { recursive: true });
  await fs.mkdir(WORKTREES_BASE, { recursive: true });
  try { await fs.mkdir(SANDBOX_HOME, { recursive: true }); } catch {}
  try { await chownRecursive(MAIN_WORKTREE); } catch {}
  try { await chownRecursive(WORKTREES_BASE); } catch {}
  try { await chownRecursive(SANDBOX_HOME); } catch {}
  await configureGitSafeDir();
}

async function configureGitSafeDir(): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn('git', ['config', '--global', '--add', 'safe.directory', '*']);
    p.on('error', () => resolve());
    p.on('close', () => resolve());
  });
}

function chownRecursive(dir: string): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn('chown', ['-R', `${SANDBOX_UID}:${SANDBOX_GID}`, dir], { stdio: 'ignore' });
    p.on('error', () => resolve());
    p.on('close', () => resolve());
  });
}

/**
 * Resolve `p` relativo ao worktree ATIVO no contexto (ou MAIN_WORKTREE se
 * não houver contexto). Rejeita paths que escapam do root. Aceita tanto
 * relativos ("src/foo.ts") quanto absolutos dentro do root ("/wt/abc/src/foo.ts").
 *
 * Pra resolver explicitamente contra MAIN_WORKTREE (ignorando contexto async),
 * use `resolveSafeInWorktree(MAIN_WORKTREE, p)`.
 */
export function resolveSafe(p: string): string {
  return resolveSafeInWorktree(getWorktreePath(), p);
}

/**
 * Versão explícita: resolve `p` relativo a `root`, rejeitando escape.
 * Use quando você sabe exatamente em qual worktree quer operar (ex.: merge
 * sempre no MAIN_WORKTREE, independente do contexto async).
 */
export function resolveSafeInWorktree(root: string, p: string): string {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path fora do worktree: ${p}`);
  }
  return abs;
}

export function toRelative(abs: string): string {
  return path.relative(getWorktreePath(), abs) || '.';
}
