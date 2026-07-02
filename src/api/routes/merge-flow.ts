import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ErrorResponse } from '../schemas/common.js';
import {
  CleanupAfterMergeReq,
  CleanupAfterMergeRes,
  CompleteMergeReq,
  MergeChatBranchReq,
  MergeIntoParentReq,
  MergeFlowResultSchema,
} from '../schemas/merge-flow.js';
import {
  cleanupAfterMerge,
  completeMergePendingPush,
  mergeChatBranchToMain,
  mergeBranchIntoParent,
} from '../../git/merge-flow.js';

/**
 * Endpoints REST do merge atômico chat-branch → main (Fase 2 — F2.5).
 *
 *   POST /api/v1/git/merge-chat-branch     → fluxo completo
 *   POST /api/v1/git/merge-complete        → pós conflict resolution
 *   POST /api/v1/git/merge-cleanup         → remove worktree + branch local
 *
 * Estas rotas operam intrinsecamente no MAIN_WORKTREE. NÃO respeitam o
 * header X-Sandbox-Worktree (mesmo princípio das rotas /worktree/* e
 * /main/*).
 */
const mergeFlowRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/git/merge-chat-branch',
    {
      schema: {
        body: MergeChatBranchReq,
        response: {
          200: MergeFlowResultSchema,
          500: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      try {
        const r = await mergeChatBranchToMain(req.body);
        return r;
      } catch (e) {
        return reply.code(500).send({
          error: (e as Error).message,
          code: 'MERGE_FAILED',
        });
      }
    },
  );

  // Merge LOCAL sub→pai: mergeia a branch do subagente na branch do pai,
  // DENTRO da worktree do pai. Sem push origin. Pro fluxo: pai (orquestrador)
  // numa branch derivada da master; executores criam sub-branches abaixo,
  // terminam e voltam pra branch do pai; o pai depois decide master/PR.
  app.post(
    '/git/merge-into-parent',
    {
      schema: {
        body: MergeIntoParentReq,
        response: {
          200: MergeFlowResultSchema,
          500: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      try {
        return await mergeBranchIntoParent(req.body);
      } catch (e) {
        return reply.code(500).send({
          error: (e as Error).message,
          code: 'MERGE_INTO_PARENT_FAILED',
        });
      }
    },
  );

  app.post(
    '/git/merge-complete',
    {
      schema: {
        body: CompleteMergeReq,
        response: {
          200: MergeFlowResultSchema,
          500: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      try {
        const r = await completeMergePendingPush(req.body);
        return r;
      } catch (e) {
        return reply.code(500).send({
          error: (e as Error).message,
          code: 'MERGE_COMPLETE_FAILED',
        });
      }
    },
  );

  app.post(
    '/git/merge-cleanup',
    {
      schema: {
        body: CleanupAfterMergeReq,
        response: {
          200: CleanupAfterMergeRes,
          500: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      try {
        await cleanupAfterMerge(req.body);
        return { ok: true };
      } catch (e) {
        return reply.code(500).send({
          error: (e as Error).message,
          code: 'MERGE_CLEANUP_FAILED',
        });
      }
    },
  );
};

export default mergeFlowRoutes;
