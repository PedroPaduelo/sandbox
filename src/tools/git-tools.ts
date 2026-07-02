import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as gitSvc from '../git/service.js';
import { stagePaths, createCommit } from '../git/commit.js';
import { getWorktreePath } from '../workspace.js';

// C-8: git como tools MCP de PRIMEIRA CLASSE. Antes o agente só alcançava git
// via `run_command "git ..."` (shell cru, sem o tratamento da camada git/*).
// Aqui expomos as ops do loop comum (status/diff/log/branch/commit) reusando
// src/git/* — que já rodam com drop-priv (uid 1001), redaction e sanitização.
// Push/branch-publish continuam fora (precisam de token de remote, que vive na
// orquestração do app-core, não no contexto do agente).

const okText = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const okJson = (obj: unknown) => okText(JSON.stringify(obj));
const err = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true });

const TIMEOUT_MS = 30_000;

export function registerGitTools(server: McpServer): void {
  server.registerTool(
    'git_status',
    {
      description:
        'Status do git no worktree do chat (porcelain): branch, arquivos staged/unstaged/untracked.',
      inputSchema: {},
    },
    async () => {
      try {
        return okJson(await gitSvc.status());
      } catch (e) {
        return err(`git_status falhou: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'git_diff',
    {
      description:
        'Diff do worktree. Sem args = working tree vs HEAD. `staged:true` = index vs HEAD. `path` limita a um arquivo/dir.',
      inputSchema: {
        path: z.string().optional().describe('Path relativo (opcional)'),
        staged: z.boolean().optional().describe('Diff do que está staged (--cached)'),
      },
    },
    async ({ path, staged }) => {
      try {
        return okText(await gitSvc.diff({ path, staged }));
      } catch (e) {
        return err(`git_diff falhou: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'git_log',
    {
      description: 'Histórico de commits do worktree (mais recentes primeiro).',
      inputSchema: {
        limit: z.number().int().positive().max(200).optional().describe('Máx de commits (default 20)'),
        path: z.string().optional().describe('Limita ao histórico de um path'),
      },
    },
    async ({ limit, path }) => {
      try {
        return okJson(await gitSvc.log({ limit: limit ?? 20, path }));
      } catch (e) {
        return err(`git_log falhou: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'git_branch_list',
    {
      description: 'Lista branches (local + remoto) e indica a branch atual.',
      inputSchema: {},
    },
    async () => {
      try {
        return okJson(await gitSvc.branches());
      } catch (e) {
        return err(`git_branch_list falhou: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'git_commit',
    {
      description:
        'Faz stage e commita no worktree do chat (commit LOCAL — não dá push). Por padrão commita TODAS as mudanças; passe `paths` para commitar só alguns. O push/merge pra main é feito pela orquestração do chat (chat_merge_to_main / chat_open_pr), não aqui.',
      inputSchema: {
        message: z.string().min(1).describe('Mensagem do commit'),
        paths: z
          .array(z.string())
          .optional()
          .describe('Paths a commitar (default: tudo, equivalente a `git add .`)'),
        amend: z.boolean().optional().describe('Reescreve o último commit (--amend)'),
      },
    },
    async ({ message, paths, amend }) => {
      const cwd = getWorktreePath();
      try {
        await stagePaths({ cwd, paths: paths && paths.length ? paths : ['.'], timeoutMs: TIMEOUT_MS });
        const r = await createCommit({ cwd, message, amend, timeoutMs: TIMEOUT_MS });
        return okJson(r);
      } catch (e) {
        return err(`git_commit falhou: ${(e as Error).message}`);
      }
    },
  );
}
