import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { ErrorResponse } from '../schemas/common.js';
import { spawn } from 'node:child_process';
import { getWorktreePath } from '../../workspace.js';
import { withAuthenticatedRemote } from '../../git/remote-auth.js';
import { wrapWithDropPriv } from '../../util/sandbox.js';

/**
 * Auto-push do branch do chat (F2.6).
 *
 *   POST /api/v1/git/push-chat-branch
 *
 * Opera no worktree contextual (lê o header `X-Sandbox-Worktree` via ALS).
 * Detecta a branch corrente do worktree (HEAD via rev-parse) e faz
 * `git push -u origin <branch>` autenticado. Best-effort: falha de rede
 * volta erro 502 — motor/app-core decide o que fazer.
 *
 * Diferente do `POST /api/v1/git/push` original (em git.ts), aqui:
 *   - cwd vem do ALS (worktree do chat), não passado explicito.
 *   - branch é descoberto do HEAD do worktree.
 *   - foco em "sync rápido pós-turno", não user-initiated.
 */

const PushChatBranchReq = Type.Object({
  token: Type.Optional(Type.String()),
});

const PushChatBranchRes = Type.Object({
  branch: Type.String(),
  pushedAt: Type.String({ format: 'date-time' }),
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGit(args: string[], cwd: string, timeoutMs = 60_000): Promise<RunResult> {
  // git roda como uid 1001 (uniformidade de ownership do .git — ver
  // git/clone.ts). Fallback gracioso sem setpriv.
  const [bin, ...binArgs] = await wrapWithDropPriv(['git', ...args]);
  return new Promise((resolve, reject) => {
    const p = spawn(bin, binArgs, {
      cwd,
      env: {
        ...process.env,
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

const pushChatBranchRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/git/push-chat-branch',
    {
      schema: {
        body: PushChatBranchReq,
        response: {
          200: PushChatBranchRes,
          409: ErrorResponse,
          502: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const wt = getWorktreePath();
      // Descobre branch do worktree
      const r = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], wt);
      if (r.code !== 0) {
        return reply.code(409).send({
          error: `não consegui resolver HEAD do worktree: ${r.stderr.trim()}`,
          code: 'NOT_A_REPO',
        });
      }
      const branch = r.stdout.trim();
      if (!branch || branch === 'HEAD') {
        return reply.code(409).send({
          error: 'worktree em detached HEAD',
          code: 'DETACHED',
        });
      }

      try {
        const push = await withAuthenticatedRemote(wt, req.body.token, () =>
          runGit(['push', '-u', 'origin', branch], wt, 60_000),
        );
        if (push.code !== 0) {
          return reply.code(502).send({
            error: `push falhou: ${push.stderr.trim()}`,
            code: 'PUSH_FAILED',
          });
        }
      } catch (err) {
        return reply.code(502).send({
          error: `push falhou: ${(err as Error).message}`,
          code: 'PUSH_FAILED',
        });
      }

      return { branch, pushedAt: new Date().toISOString() };
    },
  );
};

export default pushChatBranchRoutes;
