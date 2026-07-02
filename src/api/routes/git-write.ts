/**
 * Rotas write-side: stage / unstage / commit / branch CRUD / publish.
 * Extraídas de `git.ts` (separação read-only vs write para manter cada arquivo
 * abaixo de ~250 linhas).
 */

import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { ErrorResponse } from '../schemas/common.js';
import {
  mapGitCommitError,
  mapGitBranchError,
  mapGitApplyError,
} from '../../http/routes/git/error-map.js';
import {
  GitStageReq, GitUnstageReq, GitCommitReq, GitCommitRes,
  GitBranchCreateReq, GitBranchCheckoutReq,
  GitBranchDeleteQuery,
  GitBranchPublishReq, GitBranchOpRes,
  GitApplyReq, GitApplyRes,
} from '../schemas/git.js';
import {
  stagePaths,
  unstagePaths,
  createCommit,
} from '../../git/commit.js';
import { GitCommitError } from '../../git/commit-error.js';
import {
  createBranch,
  checkoutBranch,
  deleteBranch,
  publishBranch,
} from '../../git/branch.js';
import { GitBranchError } from '../../git/branch-error.js';
import { applyPatch } from '../../git/apply.js';
import { GitApplyError } from '../../git/apply-error.js';
import { getWorktreePath } from '../../workspace.js';

const STAGE_TIMEOUT_MS = 30_000;
const COMMIT_TIMEOUT_MS = 30_000;
const BRANCH_TIMEOUT_MS = 30_000;
const PUBLISH_TIMEOUT_MS = 90_000;
const APPLY_TIMEOUT_MS = 30_000;

const gitWriteRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post('/git/stage', {
    schema: {
      body: GitStageReq,
      response: {
        204: Type.Null(),
        400: ErrorResponse,
        408: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    try {
      await stagePaths({
        cwd: getWorktreePath(),
        paths: req.body.paths,
        timeoutMs: STAGE_TIMEOUT_MS,
      });
      return reply.code(204).send(null);
    } catch (e) {
      if (e instanceof GitCommitError) return mapGitCommitError(e, reply);
      throw e;
    }
  });

  app.post('/git/unstage', {
    schema: {
      body: GitUnstageReq,
      response: {
        204: Type.Null(),
        400: ErrorResponse,
        408: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    try {
      await unstagePaths({
        cwd: getWorktreePath(),
        paths: req.body.paths,
        timeoutMs: STAGE_TIMEOUT_MS,
      });
      return reply.code(204).send(null);
    } catch (e) {
      if (e instanceof GitCommitError) return mapGitCommitError(e, reply);
      throw e;
    }
  });

  app.post('/git/commit', {
    schema: {
      body: GitCommitReq,
      response: {
        200: GitCommitRes,
        408: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    req.log.info({ messageLen: req.body.message?.length, hasAuthor: !!req.body.author, author: req.body.author }, '[git/commit] received');
    try {
      const result = await createCommit({
        cwd: getWorktreePath(),
        message: req.body.message,
        author: req.body.author,
        amend: req.body.amend ?? false,
        timeoutMs: COMMIT_TIMEOUT_MS,
      });
      req.log.info({ hash: result.hash }, '[git/commit] success');
      return { ok: true as const, ...result };
    } catch (e) {
      if (e instanceof GitCommitError) {
        req.log.warn({ code: e.code, message: e.message }, '[git/commit] GitCommitError');
        return mapGitCommitError(e, reply);
      }
      req.log.error({ err: e instanceof Error ? { message: e.message, stack: e.stack, name: e.name } : e }, '[git/commit] unexpected error');
      throw e;
    }
  });

  app.post('/git/branch/create', {
    schema: {
      body: GitBranchCreateReq,
      response: {
        200: GitBranchOpRes,
        403: ErrorResponse,
        404: ErrorResponse,
        408: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    try {
      const r = await createBranch({
        cwd: getWorktreePath(),
        name: req.body.name,
        checkout: req.body.checkout ?? false,
        timeoutMs: BRANCH_TIMEOUT_MS,
      });
      return { ok: true as const, branch: r.branch };
    } catch (e) {
      if (e instanceof GitBranchError) return mapGitBranchError(e, reply);
      throw e;
    }
  });

  app.post('/git/branch/checkout', {
    schema: {
      body: GitBranchCheckoutReq,
      response: {
        200: GitBranchOpRes,
        403: ErrorResponse,
        404: ErrorResponse,
        408: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    try {
      const result = await checkoutBranch({
        cwd: getWorktreePath(),
        name: req.body.name,
        timeoutMs: BRANCH_TIMEOUT_MS,
      });
      return { ok: true as const, branch: req.body.name, detached: result.detached };
    } catch (e) {
      if (e instanceof GitBranchError) return mapGitBranchError(e, reply);
      throw e;
    }
  });

  // Wildcard `*` (não `:name`) para aceitar branch com `/` no nome (ex.
  // `feat/x`, `<branch>/<slug>` dos subagentes). Um param de segmento único
  // (`:name`) dá 404 quando o `%2F` da URL é normalizado pra `/` na cadeia
  // gateway→fastify. O `*` casa o resto do path, barras incluídas.
  app.delete('/git/branch/*', {
    schema: {
      querystring: GitBranchDeleteQuery,
      response: {
        200: GitBranchOpRes,
        403: ErrorResponse,
        404: ErrorResponse,
        408: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    const name = (req.params as Record<string, string>)['*'] ?? '';
    if (!name) {
      return reply.code(404).send({ error: 'branch name missing', code: 'NOT_FOUND' });
    }
    try {
      await deleteBranch({
        cwd: getWorktreePath(),
        name,
        force: req.query.force ?? false,
        allowUnmerged: req.query.allowUnmerged ?? false,
        timeoutMs: BRANCH_TIMEOUT_MS,
      });
      return { ok: true as const, branch: name };
    } catch (e) {
      if (e instanceof GitBranchError) return mapGitBranchError(e, reply);
      throw e;
    }
  });

  app.post('/git/apply', {
    schema: {
      body: GitApplyReq,
      response: {
        200: GitApplyRes,
        400: ErrorResponse,
        408: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    try {
      await applyPatch({
        cwd: getWorktreePath(),
        patch: req.body.patch,
        cached: req.body.cached ?? false,
        reverse: req.body.reverse ?? false,
        timeoutMs: APPLY_TIMEOUT_MS,
      });
      return { ok: true as const };
    } catch (e) {
      if (e instanceof GitApplyError) return mapGitApplyError(e, reply);
      throw e;
    }
  });

  app.post('/git/branch/publish', {
    schema: {
      body: GitBranchPublishReq,
      response: {
        200: GitBranchOpRes,
        401: ErrorResponse,
        403: ErrorResponse,
        408: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    try {
      const r = await publishBranch({
        cwd: getWorktreePath(),
        name: req.body.name,
        token: req.body.token,
        timeoutMs: PUBLISH_TIMEOUT_MS,
      });
      return {
        ok: true as const,
        branch: r.branch,
        upstreamCreated: r.upstreamCreated,
      };
    } catch (e) {
      if (e instanceof GitBranchError) return mapGitBranchError(e, reply);
      throw e;
    }
  });
};

export default gitWriteRoutes;
