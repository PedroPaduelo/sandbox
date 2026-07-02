import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ErrorResponse } from '../schemas/common.js';
import {
  WorktreeCreateReq,
  WorktreeCreateRes,
  WorktreeIdParams,
  WorktreeListRes,
  WorktreeRemoveQuery,
} from '../schemas/worktree.js';
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  WorktreeError,
} from '../../git/worktree.js';

/**
 * Endpoints REST de gestão de worktrees (Fase 2 — worktree-feature).
 * Chamados pelo app-core durante criação/arquivamento de chats.
 *
 * Estas rotas operam SEMPRE no MAIN_WORKTREE — não respeitam o header
 * X-Sandbox-Worktree porque seu propósito é gerenciar a topologia de
 * worktrees, não operar dentro de um worktree.
 */
const worktreeRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/worktree/create',
    {
      schema: {
        body: WorktreeCreateReq,
        response: {
          200: WorktreeCreateRes,
          409: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      try {
        const r = await createWorktree(req.body);
        return r;
      } catch (e) {
        if (e instanceof WorktreeError) {
          const status =
            e.code === 'ALREADY_EXISTS' || e.code === 'BRANCH_IN_USE'
              ? 409
              : 500;
          return reply.code(status).send({ error: e.message, code: e.code });
        }
        throw e;
      }
    },
  );

  app.delete(
    '/worktree/:conversationId',
    {
      schema: {
        params: WorktreeIdParams,
        querystring: WorktreeRemoveQuery,
        response: {
          204: { type: 'null' },
          500: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      try {
        await removeWorktree({
          conversationId: req.params.conversationId,
          force: req.query.force ?? false,
        });
        return reply.code(204).send(null);
      } catch (e) {
        if (e instanceof WorktreeError) {
          return reply.code(500).send({ error: e.message, code: e.code });
        }
        throw e;
      }
    },
  );

  app.get(
    '/worktree',
    {
      schema: {
        response: {
          200: WorktreeListRes,
          500: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      try {
        const worktrees = await listWorktrees();
        return { worktrees };
      } catch (e) {
        if (e instanceof WorktreeError) {
          return reply.code(500).send({ error: e.message, code: e.code });
        }
        throw e;
      }
    },
  );
};

export default worktreeRoutes;
