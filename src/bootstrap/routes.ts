import type { FastifyInstance } from 'fastify';
import { mcpHandler } from '../mcp/handler.js';
import apiPlugin from '../api/plugin.js';

export async function registerAllRoutes(app: FastifyInstance): Promise<void> {
  app.post('/mcp', mcpHandler);
  app.get('/mcp', mcpHandler);
  app.delete('/mcp', mcpHandler);

  await app.register(apiPlugin);
}
