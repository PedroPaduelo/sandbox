import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { ensureWorkspace } from './workspace.js';
import { registerPlugins, registerHealthcheck } from './bootstrap/plugins.js';
import { registerAllRoutes } from './bootstrap/routes.js';
import { errorHandler } from './http/error-handler.js';
import { killAllBgProcesses } from './tools/processes.js';
import { closeAllWatchers } from './fs/watcher-registry.js';
import { sessions } from './mcp/sessions.js';
import { env } from './lib/env.js';
import { LspServerPool } from './lsp/lspPool.js';
import { registerLspRoute } from './lsp/wsRoute.js';

async function main(): Promise<void> {
  await ensureWorkspace();

  // bodyLimit global de 350 MB suporta upload de docs grandes (CSV/Excel/PDF)
  // via PUT /fs/file/raw a partir do composer do chat. MCP usa o mesmo teto.
  const app = Fastify({ logger: { level: 'info' }, bodyLimit: 350 * 1024 * 1024 });

  app.setErrorHandler(errorHandler);

  await registerPlugins(app);
  registerHealthcheck(app);
  await registerAllRoutes(app);

  // LSP bridge: registra @fastify/websocket + rota WS /v1/lsp/:lang.
  // O pool é singleton no processo (idle/memory eviction internos).
  await app.register(websocket);
  const lspPool = new LspServerPool({
    workspaceRoot: env.workspace,
    logger: {
      info: (o, m) => app.log.info(o, m),
      warn: (o, m) => app.log.warn(o, m),
      error: (o, m) => app.log.error(o, m),
    },
  });
  registerLspRoute(app, { pool: lspPool });

  const shutdown = async (): Promise<void> => {
    app.log.info('shutting down');
    killAllBgProcesses();
    await closeAllWatchers();
    await lspPool.dispose();
    for (const [, s] of sessions) await s.transport.close().catch(() => {});
    sessions.clear();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ host: '0.0.0.0', port: env.PORT });
  app.log.info(`MCP Streamable HTTP em 0.0.0.0:${env.PORT}/mcp (workspace: ${env.workspace})`);
}

main().catch((e) => {
  console.error('[sandbox-agent] fatal:', e);
  process.exit(1);
});
