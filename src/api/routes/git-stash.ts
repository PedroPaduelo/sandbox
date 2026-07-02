/**
 * Sub-plugin: rotas de `git stash` — push / list / pop / apply / drop.
 * Registrado por `git.ts` dentro do prefixo `/api/v1`.
 */

import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ErrorResponse } from '../schemas/common.js';
import { mapGitStashError } from '../../http/routes/git/error-map.js';
import {
  GitStashPushReq,
  GitStashPushRes,
  GitStashListRes,
  GitStashRefReq,
  GitStashDropReq,
  GitStashOpRes,
} from '../schemas/git.js';
import {
  stashPush,
  stashList,
  stashPop,
  stashApply,
  stashDrop,
} from '../../git/stash.js';
import { GitStashError } from '../../git/stash-error.js';
import { getWorktreePath } from '../../workspace.js';

const STASH_TIMEOUT_MS = 30_000;

const gitStashRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post('/git/stash/push', {
    schema: {
      body: GitStashPushReq,
      response: {
        200: GitStashPushRes,
        408: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    try {
      const r = await stashPush({
        cwd: getWorktreePath(),
        message: req.body.message,
        includeUntracked: req.body.includeUntracked ?? false,
        timeoutMs: STASH_TIMEOUT_MS,
      });
      return { ok: true as const, created: r.created };
    } catch (e) {
      if (e instanceof GitStashError) return mapGitStashError(e, reply);
      throw e;
    }
  });

  app.get('/git/stash/list', {
    schema: {
      response: {
        200: GitStashListRes,
        408: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (_req, reply) => {
    try {
      return await stashList({
        cwd: getWorktreePath(),
        timeoutMs: STASH_TIMEOUT_MS,
      });
    } catch (e) {
      if (e instanceof GitStashError) return mapGitStashError(e, reply);
      throw e;
    }
  });

  app.post('/git/stash/pop', {
    schema: {
      body: GitStashRefReq,
      response: {
        200: GitStashOpRes,
        400: ErrorResponse,
        404: ErrorResponse,
        408: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    try {
      await stashPop({
        cwd: getWorktreePath(),
        ref: req.body.ref,
        timeoutMs: STASH_TIMEOUT_MS,
      });
      return { ok: true as const };
    } catch (e) {
      if (e instanceof GitStashError) return mapGitStashError(e, reply);
      throw e;
    }
  });

  app.post('/git/stash/apply', {
    schema: {
      body: GitStashRefReq,
      response: {
        200: GitStashOpRes,
        400: ErrorResponse,
        404: ErrorResponse,
        408: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    try {
      await stashApply({
        cwd: getWorktreePath(),
        ref: req.body.ref,
        timeoutMs: STASH_TIMEOUT_MS,
      });
      return { ok: true as const };
    } catch (e) {
      if (e instanceof GitStashError) return mapGitStashError(e, reply);
      throw e;
    }
  });

  app.post('/git/stash/drop', {
    schema: {
      body: GitStashDropReq,
      response: {
        200: GitStashOpRes,
        400: ErrorResponse,
        404: ErrorResponse,
        408: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    try {
      await stashDrop({
        cwd: getWorktreePath(),
        ref: req.body.ref,
        timeoutMs: STASH_TIMEOUT_MS,
      });
      return { ok: true as const };
    } catch (e) {
      if (e instanceof GitStashError) return mapGitStashError(e, reply);
      throw e;
    }
  });
};

export default gitStashRoutes;
