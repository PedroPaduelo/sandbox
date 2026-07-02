/**
 * Merge conflict routes: list conflicts, resolve per-file, abort, continue.
 */

import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { ErrorResponse } from '../schemas/common.js';
import {
  listConflicts,
  resolveConflict,
  abortMerge,
  continueMerge,
  GitMergeError,
} from '../../git/merge.js';
import { FastifyReply } from 'fastify';

const ConflictsRes = Type.Object({
  files: Type.Array(Type.String()),
});

const ResolveReq = Type.Object({
  path: Type.String({ minLength: 1 }),
  resolution: Type.Union([
    Type.Literal('ours'),
    Type.Literal('theirs'),
    Type.Literal('both'),
  ]),
});

const OkRes = Type.Object({ ok: Type.Literal(true) });

function isValidPath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith('/')) return false;
  if (p.includes('..')) return false;
  return true;
}

function mapMergeError(err: unknown, reply: FastifyReply): { error: string; code?: string } {
  if (err instanceof GitMergeError) {
    let status = 500;
    switch (err.code) {
      case 'NOT_IN_MERGE':
        status = 409;
        break;
      case 'INVALID_PATH':
        status = 400;
        break;
      case 'NOT_A_REPO':
        status = 409;
        break;
      case 'TIMEOUT':
        status = 408;
        break;
      case 'IO_FAILED':
        status = 500;
        break;
      default:
        status = 500;
    }
    reply.code(status);
    return { error: err.message, code: err.code };
  }
  reply.code(500);
  const msg = err instanceof Error ? err.message : String(err);
  return { error: msg };
}

const gitMergeRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get('/git/conflicts', {
    schema: {
      response: {
        200: ConflictsRes,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (_, reply) => {
    try {
      const files = await listConflicts();
      return { files };
    } catch (e) {
      return mapMergeError(e, reply);
    }
  });

  app.post('/git/resolve', {
    schema: {
      body: ResolveReq,
      response: {
        200: OkRes,
        400: ErrorResponse,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    if (!isValidPath(req.body.path)) {
      reply.code(400);
      return { error: 'invalid path', code: 'INVALID_PATH' };
    }
    try {
      await resolveConflict(req.body.path, req.body.resolution);
      return { ok: true as const };
    } catch (e) {
      return mapMergeError(e, reply);
    }
  });

  app.post('/git/merge/abort', {
    schema: {
      response: {
        200: OkRes,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (_, reply) => {
    try {
      await abortMerge();
      return { ok: true as const };
    } catch (e) {
      return mapMergeError(e, reply);
    }
  });

  app.post('/git/merge/continue', {
    schema: {
      response: {
        200: OkRes,
        409: ErrorResponse,
        500: ErrorResponse,
      },
    },
  }, async (_, reply) => {
    try {
      await continueMerge();
      return { ok: true as const };
    } catch (e) {
      return mapMergeError(e, reply);
    }
  });
};

export default gitMergeRoutes;
