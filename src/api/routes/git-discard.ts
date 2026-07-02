/**
 * Rotas write-side: discard / discard-all.
 *
 * Extraídas de `git-write.ts` para manter cada arquivo abaixo de ~250 linhas.
 * Frontend manda só paths (ou nenhum, em discard-all); o backend lê
 * `git status` e classifica cada path em um bucket antes de aplicar a
 * operação certa via `discardPaths` (em `git/discard.ts`).
 */

import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ErrorResponse } from '../schemas/common.js';
import { GitDiscardReq, GitDiscardRes } from '../schemas/git.js';
import { mapGitCommitError } from '../../http/routes/git/error-map.js';
import { GitCommitError } from '../../git/commit-error.js';
import { discardPaths, readStatusBuckets } from '../../git/discard.js';
import { getWorktreePath } from '../../workspace.js';

const DISCARD_TIMEOUT_MS = 30_000;

const gitDiscardRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post('/git/discard', {
    schema: {
      body: GitDiscardReq,
      response: {
        200: GitDiscardRes,
        400: ErrorResponse,
        408: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    req.log.info({ pathsCount: req.body.paths.length }, '[git/discard] received');
    try {
      const status = await readStatusBuckets(getWorktreePath());
      const r = await discardPaths({
        cwd: getWorktreePath(),
        paths: req.body.paths,
        status,
        timeoutMs: DISCARD_TIMEOUT_MS,
      });
      req.log.info(
        { discarded: r.discarded.length, skipped: r.skipped.length },
        '[git/discard] success',
      );
      return { ok: true as const, ...r };
    } catch (e) {
      if (e instanceof GitCommitError) {
        req.log.warn({ code: e.code, message: e.message }, '[git/discard] GitCommitError');
        return mapGitCommitError(e, reply);
      }
      req.log.error(
        { err: e instanceof Error ? { message: e.message, stack: e.stack, name: e.name } : e },
        '[git/discard] unexpected error',
      );
      throw e;
    }
  });

  app.post('/git/discard-all', {
    schema: {
      response: {
        200: GitDiscardRes,
        408: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    req.log.info({}, '[git/discard-all] received');
    try {
      const status = await readStatusBuckets(getWorktreePath());
      const all = [...status.staged, ...status.unstaged, ...status.untracked];
      if (all.length === 0) {
        req.log.info({}, '[git/discard-all] clean workspace, noop');
        return { ok: true as const, discarded: [], skipped: [] };
      }
      const r = await discardPaths({
        cwd: getWorktreePath(),
        paths: all,
        status,
        timeoutMs: DISCARD_TIMEOUT_MS,
      });
      req.log.info(
        { discarded: r.discarded.length, skipped: r.skipped.length },
        '[git/discard-all] success',
      );
      return { ok: true as const, ...r };
    } catch (e) {
      if (e instanceof GitCommitError) {
        req.log.warn({ code: e.code, message: e.message }, '[git/discard-all] GitCommitError');
        return mapGitCommitError(e, reply);
      }
      req.log.error(
        { err: e instanceof Error ? { message: e.message, stack: e.stack, name: e.name } : e },
        '[git/discard-all] unexpected error',
      );
      throw e;
    }
  });
};

export default gitDiscardRoutes;
