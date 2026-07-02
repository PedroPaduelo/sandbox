import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export const sessions = new Map<string, Session>();

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'sandbox-agent', version: '0.1.0' });
  return server;
}
