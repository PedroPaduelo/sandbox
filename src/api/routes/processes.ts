import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import {
  getManagedProcessOutput,
  killManagedProcess,
  listManagedProcesses,
  restartManagedProcess,
} from '../../tools/processes.js';
import {
  KillProcessParams,
  KillProcessRes,
  ListProcessesRes,
  LogsParams,
  LogsQuery,
  LogsRes,
  RestartProcessReq,
  RestartProcessRes,
} from '../schemas/processes.js';
import { ErrorResponse } from '../schemas/common.js';

/**
 * Rotas REST de gestão de processos. Espelham as tools MCP de `tools/processes.ts`,
 * delegando aos helpers públicos (`listManagedProcesses`, `killManagedProcess`,
 * `restartManagedProcess`, `getManagedProcessOutput`).
 *
 * Existem porque o painel "Processes" no IDE (F1.5) precisa enxergar/agir
 * sobre processos sem passar pelo motor — UI direta via gateway → sandbox.
 */
const processRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // GET /processes — snapshot do bgProcesses Map
  app.get(
    '/processes',
    {
      schema: {
        response: { 200: ListProcessesRes },
      },
    },
    async () => {
      return { processes: listManagedProcesses() };
    },
  );

  // POST /processes/:id/kill — SIGKILL no processo, stop do scope se houver
  app.post(
    '/processes/:id/kill',
    {
      schema: {
        params: KillProcessParams,
        response: {
          200: KillProcessRes,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const r = await killManagedProcess(id);
      if (!r.ok) {
        return reply.code(404).send({ error: `processId ${id} não encontrado`, code: 'NOT_FOUND' });
      }
      return {
        processId: r.processId,
        status: r.status,
        scopeStopped: r.scopeStopped,
        note: r.note,
      };
    },
  );

  // POST /processes/restart — equivalente REST de `restart_managed_process`
  app.post(
    '/processes/restart',
    {
      schema: {
        body: RestartProcessReq,
        response: {
          200: RestartProcessRes,
          409: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const r = await restartManagedProcess(req.body);
      if (!r.ok) {
        const status = r.code === 'PORT_BUSY' ? 409 : 500;
        return reply.code(status).send({ error: r.error, code: r.code });
      }
      return r.result;
    },
  );

  // GET /processes/:id/logs — output acumulado (com tail opcional)
  app.get(
    '/processes/:id/logs',
    {
      schema: {
        params: LogsParams,
        querystring: LogsQuery,
        response: {
          200: LogsRes,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const tail = req.query.tailLines ?? 50;
      const out = getManagedProcessOutput(id, tail);
      if (!out) {
        return reply.code(404).send({ error: `processId ${id} não encontrado`, code: 'NOT_FOUND' });
      }
      return out;
    },
  );
};

export default processRoutes;
