import type { FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { sessions, createMcpServer, type Session } from './sessions.js';
import { registerFilesystemTools } from '../tools/filesystem.js';
import { registerShellTool } from '../tools/shell.js';
import { registerProcessTools } from '../tools/processes.js';
import { registerSystemTools } from '../tools/system.js';
import { registerGitTools } from '../tools/git-tools.js';

export async function mcpHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = req.headers['mcp-session-id'];
  const sidStr = typeof sessionId === 'string' ? sessionId : undefined;

  let session: Session | undefined = sidStr ? sessions.get(sidStr) : undefined;

  if (!session) {
    const isInit = req.method === 'POST' && isInitializeRequest(req.body);
    if (!isInit) {
      reply.code(400).send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      });
      return;
    }

    const server = createMcpServer();
    registerFilesystemTools(server);
    registerShellTool(server);
    registerProcessTools(server);
    // Tools de instalação de pacotes/runtimes (apt-get + installers oficiais).
    // O sandbox é por-usuário/projeto e a equipe atual é confiável — agente
    // pode instalar tudo que precisa. Roda fora do bwrap (como root no
    // container) porque apt-get/rustup/etc escrevem em /usr e /var.
    registerSystemTools(server);
    // C-8: git como tools de primeira classe (status/diff/log/branch/commit),
    // reusando src/git/* (drop-priv + redaction) em vez de `run_command` cru.
    registerGitTools(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, server });
        req.log.info(`[mcp] sessão aberta: ${sid} (total=${sessions.size})`);
      },
      onsessionclosed: (sid) => {
        sessions.delete(sid);
        req.log.info(`[mcp] sessão fechada: ${sid} (total=${sessions.size})`);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    session = { transport, server };
  }

  reply.hijack();
  await session.transport.handleRequest(req.raw, reply.raw, req.body);
}
