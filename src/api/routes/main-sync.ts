import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ErrorResponse } from '../schemas/common.js';
import { MainSyncReq, MainSyncRes } from '../schemas/worktree.js';
import {
  fetchRepo,
  pullRepo,
  DEFAULT_SYNC_TIMEOUTS,
} from '../../git/sync.js';
import { GitSyncError } from '../../git/sync-error.js';
import { mapGitSyncError } from '../../http/routes/git/error-map.js';
import { MAIN_WORKTREE } from '../../workspace.js';

/**
 * Endpoints de sync DEDICADOS ao MAIN_WORKTREE (Fase 2 — worktree-feature).
 *
 * Diferentes das rotas `/git/fetch` e `/git/pull` (em git.ts) que operam
 * no worktree contextual (do chat). Aqui o destino é SEMPRE MAIN_WORKTREE
 * — usado pelo app-core na criação de chats novos pra garantir que a base
 * branch reflete o que está no GitHub antes de spawnar um worktree novo.
 */
const mainSyncRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/main/fetch',
    {
      schema: {
        body: MainSyncReq,
        response: {
          200: MainSyncRes,
          401: ErrorResponse,
          408: ErrorResponse,
          409: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      try {
        return await fetchRepo({
          workspace: MAIN_WORKTREE,
          token: req.body.token,
          all: req.body.all ?? false,
          prune: req.body.prune ?? true,
          timeoutMs: DEFAULT_SYNC_TIMEOUTS.fetch,
        });
      } catch (e) {
        if (e instanceof GitSyncError) return mapGitSyncError(e, reply);
        throw e;
      }
    },
  );

  app.post(
    '/main/pull',
    {
      schema: {
        body: MainSyncReq,
        response: {
          200: MainSyncRes,
          401: ErrorResponse,
          408: ErrorResponse,
          409: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      try {
        return await pullRepo({
          workspace: MAIN_WORKTREE,
          token: req.body.token,
          ref: 'main',
          ffOnly: true,
          timeoutMs: DEFAULT_SYNC_TIMEOUTS.pull,
        });
      } catch (e) {
        if (e instanceof GitSyncError) return mapGitSyncError(e, reply);
        throw e;
      }
    },
  );
};

export default mainSyncRoutes;
