import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { runShellCommand } from '../../tools/shell.js';
import { ExecRunReq, ExecRunRes } from '../schemas/exec.js';
import { ErrorResponse } from '../schemas/common.js';

const execRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // ── POST /exec/run ──────────────────────────────────────────────────
  // Espelha o MCP run_command numa rota REST acessível pelo frontend
  // através do gateway (/project/:projectId/api/v1/exec/run).
  app.post(
    '/exec/run',
    {
      schema: {
        body: ExecRunReq,
        response: {
          200: ExecRunRes,
          400: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const { cmd, cwd } = req.body;
      try {
        const result = await runShellCommand(cmd, cwd);
        return result;
      } catch (e) {
        const msg = (e as Error).message;
        // resolveSafe lança quando cwd sai do workspace — devolvemos 400
        if (/workspace|path/i.test(msg)) {
          return reply.code(400).send({ error: msg, code: 'EINVAL' });
        }
        return reply.code(500).send({ error: msg, code: 'EEXEC' });
      }
    },
  );
};

export default execRoutes;
