import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import * as gitSvc from '../../git/service.js';
import { GitError } from '../../git/service.js';
import { ErrorResponse } from '../schemas/common.js';
import {
  mapGitError,
  mapGitCloneError,
  mapGitSyncError,
} from '../../http/routes/git/error-map.js';
import {
  GitStatus, GitBranches, GitLogReq, GitLogRes,
  GitDiffReq, GitBlameReq, GitBlameRes, GitShowReq,
  GitCloneReq, GitCloneRes,
  GitPullReq, GitPullRes,
  GitPushReq, GitPushRes,
  GitFetchReq, GitFetchRes,
} from '../schemas/git.js';
import { cloneRepo } from '../../git/clone-repo.js';
import { GitCloneError } from '../../git/clone-error.js';
import {
  pullRepo,
  pushRepo,
  fetchRepo,
  DEFAULT_SYNC_TIMEOUTS,
} from '../../git/sync.js';
import { GitSyncError } from '../../git/sync-error.js';
import { env } from '../../lib/env.js';
import { getWorktreePath, MAIN_WORKTREE } from '../../workspace.js';
import gitWriteRoutes from './git-write.js';
import gitDiscardRoutes from './git-discard.js';
import gitStashRoutes from './git-stash.js';
import gitMergeRoutes from './git-merge.js';

const gitRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get('/git/status', {
    schema: { response: { 200: GitStatus, 408: ErrorResponse, 409: ErrorResponse } },
  }, async (_, reply) => {
    try { return await gitSvc.status(); }
    catch (e) { mapGitError(e, reply); }
  });

  app.get('/git/branches', {
    schema: { response: { 200: GitBranches, 408: ErrorResponse, 409: ErrorResponse } },
  }, async (_, reply) => {
    try { return await gitSvc.branches(); }
    catch (e) { mapGitError(e, reply); }
  });

  app.get('/git/log', {
    schema: { querystring: GitLogReq, response: { 200: GitLogRes, 408: ErrorResponse, 409: ErrorResponse } },
  }, async (req, reply) => {
    try { return await gitSvc.log(req.query); }
    catch (e) { mapGitError(e, reply); }
  });

  app.get('/git/diff', {
    schema: {
      querystring: GitDiffReq,
      response: { 200: Type.String(), 408: ErrorResponse, 409: ErrorResponse },
    },
  }, async (req, reply) => {
    try {
      const text = await gitSvc.diff(req.query);
      reply.header('content-type', 'text/x-diff; charset=utf-8');
      reply.send(text); return;
    } catch (e) { mapGitError(e, reply); }
  });

  app.get('/git/blame', {
    schema: {
      querystring: GitBlameReq,
      response: {
        200: GitBlameRes,
        400: ErrorResponse,
        404: ErrorResponse,
        408: ErrorResponse,
        409: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    const p = req.query.path;
    if (!p || p.includes('..') || p.startsWith('/')) {
      reply.code(400);
      return { error: 'invalid path' };
    }
    try {
      const lines = await gitSvc.blame(p);
      return { lines };
    } catch (e) {
      if (e instanceof GitError && e.code === 'NOT_FOUND') {
        reply.code(404);
        return { error: e.message };
      }
      mapGitError(e, reply);
    }
  });

  app.get('/git/show', {
    schema: {
      querystring: GitShowReq,
      response: { 200: Type.String(), 408: ErrorResponse, 409: ErrorResponse, 404: ErrorResponse },
    },
  }, async (req, reply) => {
    try {
      const text = await gitSvc.show(req.query.ref, req.query.path);
      reply.header('content-type', 'text/plain; charset=utf-8');
      reply.send(text); return;
    } catch (e) { mapGitError(e, reply); }
  });

  app.post('/git/clone', {
    schema: {
      body: GitCloneReq,
      response: {
        200: GitCloneRes,
        400: ErrorResponse,
        401: ErrorResponse,
        404: ErrorResponse,
        408: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    try {
      // Clone SEMPRE no MAIN_WORKTREE — clone cria o repo central, worktrees
      // são derivados depois via `git worktree add` (F2.3).
      const result = await cloneRepo({
        url: req.body.url,
        workspace: MAIN_WORKTREE,
        ref: req.body.ref,
        token: req.body.token,
        depth: req.body.depth,
        authorName: req.body.authorName,
        authorEmail: req.body.authorEmail,
        cleanIfDirty: req.body.cleanIfDirty,
        timeoutMs: env.GIT_CLONE_TIMEOUT_MS,
      });
      return result;
    } catch (e) {
      if (e instanceof GitCloneError) return mapGitCloneError(e, reply);
      throw e;
    }
  });

  // ─── Sync: pull/push/fetch ──────────────────────────────────────────────

  app.post('/git/pull', {
    schema: {
      body: GitPullReq,
      response: {
        200: GitPullRes,
        401: ErrorResponse,
        408: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    try {
      return await pullRepo({
        workspace: getWorktreePath(),
        token: req.body.token,
        ref: req.body.ref,
        ffOnly: req.body.ffOnly ?? true,
        timeoutMs: DEFAULT_SYNC_TIMEOUTS.pull,
      });
    } catch (e) {
      if (e instanceof GitSyncError) return mapGitSyncError(e, reply);
      throw e;
    }
  });

  app.post('/git/push', {
    schema: {
      body: GitPushReq,
      response: {
        200: GitPushRes,
        401: ErrorResponse,
        403: ErrorResponse,
        408: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    try {
      return await pushRepo({
        workspace: getWorktreePath(),
        token: req.body.token,
        ref: req.body.ref,
        setUpstream: req.body.setUpstream ?? true,
        timeoutMs: DEFAULT_SYNC_TIMEOUTS.push,
      });
    } catch (e) {
      if (e instanceof GitSyncError) return mapGitSyncError(e, reply);
      throw e;
    }
  });

  app.post('/git/fetch', {
    schema: {
      body: GitFetchReq,
      response: {
        200: GitFetchRes,
        401: ErrorResponse,
        408: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    try {
      return await fetchRepo({
        workspace: getWorktreePath(),
        token: req.body.token,
        all: req.body.all ?? false,
        prune: req.body.prune ?? true,
        timeoutMs: DEFAULT_SYNC_TIMEOUTS.fetch,
      });
    } catch (e) {
      if (e instanceof GitSyncError) return mapGitSyncError(e, reply);
      throw e;
    }
  });

  // Sub-plugin: write API (stage / unstage / commit / branch CRUD / publish)
  await app.register(gitWriteRoutes);
  // Sub-plugin: discard / discard-all
  await app.register(gitDiscardRoutes);
  // Sub-plugin: stash push/list/pop/apply/drop
  await app.register(gitStashRoutes);
  // Sub-plugin: merge conflicts (list/resolve/abort/continue)
  await app.register(gitMergeRoutes);
};

export default gitRoutes;
