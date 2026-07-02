import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ActiveRuntimeRes, StopRuntimeRes } from '../schemas/runtime.js';
import { runtimeState } from '../../runtime-state.js';
import { stopActiveRuntime } from '../../tools/processes.js';

/**
 * Endpoints REST do active runtime (Fase 2 — Design A1).
 *
 *   GET  /api/v1/runtime/active → estado atual
 *   POST /api/v1/runtime/stop   → para o stack (libera as portas)
 *
 * O frontend usa /active pra mostrar "🟢 rodando" no chat correto, e pra
 * exibir o botão Run/Stop adequado no header.
 */
const runtimeRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/runtime/active',
    {
      schema: {
        response: { 200: ActiveRuntimeRes },
      },
    },
    async () => {
      return {
        activeWorktreePath: runtimeState.activeWorktreePath,
        activeConversationId: runtimeState.activeConversationId,
        startedAt: runtimeState.startedAt,
        activeServices: Array.from(runtimeState.activeServices.entries()).map(
          ([label, processId]) => ({ label, processId }),
        ),
      };
    },
  );

  app.post(
    '/runtime/stop',
    {
      schema: {
        response: { 200: StopRuntimeRes },
      },
    },
    async () => {
      return await stopActiveRuntime();
    },
  );
};

export default runtimeRoutes;
