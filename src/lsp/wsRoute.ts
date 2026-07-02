import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket as WsSocket } from 'ws';
import { env } from '../lib/env.js';
import { LspServerPool, type LspLanguage } from './lspPool.js';
import type { IWebSocket } from 'vscode-ws-jsonrpc';

const ALLOWED_LANGS: ReadonlySet<string> = new Set(['typescript', 'javascript']);

export interface RegisterLspRouteOptions {
  pool: LspServerPool;
  /**
   * Validador de token. Default valida contra `env.SANDBOX_TOKEN`. Injetável
   * pra tests poderem variar o token sem mexer no env global.
   */
  validateToken?: (token: string | undefined) => boolean;
}

const defaultValidate = (token: string | undefined): boolean =>
  typeof token === 'string' && token.length > 0 && token === env.SANDBOX_TOKEN;

/**
 * Adapter de `ws.WebSocket` -> `IWebSocket` (interface do vscode-ws-jsonrpc).
 *
 * O contrato exige `send(string)`, mas o reader interno do vscode-ws-jsonrpc
 * desempacota `data` que pode chegar como Buffer no Node — nós passamos pra
 * frente como vier; o reader lida.
 */
function adaptSocket(ws: WsSocket): IWebSocket {
  return {
    send: (content) => {
      try {
        ws.send(content);
      } catch {
        // socket pode já estar fechado entre o write e o close — não fatal.
      }
    },
    onMessage: (cb) => ws.on('message', (data) => cb(typeof data === 'string' ? data : data.toString('utf8'))),
    onError: (cb) => ws.on('error', cb),
    onClose: (cb) => ws.on('close', (code, reason) => cb(code, reason.toString('utf8'))),
    dispose: () => {
      try {
        ws.close();
      } catch {
        // idem: socket pode já estar morto.
      }
    },
  };
}

function extractBearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  return /^Bearer\s+(.+)$/i.exec(h.trim())?.[1];
}

export function registerLspRoute(app: FastifyInstance, opts: RegisterLspRouteOptions): void {
  const { pool, validateToken = defaultValidate } = opts;

  app.get<{ Params: { lang: string } }>(
    '/v1/lsp/:lang',
    { websocket: true },
    async (socket, req) => {
      const token = extractBearer(req);
      if (!validateToken(token)) {
        req.log.warn({ ip: req.ip }, 'lsp ws: auth failed');
        // 1008 = Policy Violation
        try {
          socket.close(1008, 'unauthorized');
        } catch {
          // socket pode estar em estado inválido — ignora
        }
        return;
      }

      const lang = req.params.lang;
      if (!ALLOWED_LANGS.has(lang)) {
        req.log.warn({ lang }, 'lsp ws: unsupported lang');
        // 1003 = Unsupported Data
        try {
          socket.close(1003, 'unsupported language');
        } catch {
          // idem
        }
        return;
      }

      let handle;
      try {
        handle = await pool.acquire(lang as LspLanguage);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        req.log.error({ err: msg, lang }, 'lsp ws: pool acquire failed');
        try {
          // 1011 = Internal Error
          socket.close(1011, 'lsp acquire failed');
        } catch {
          // socket já fechado
        }
        return;
      }

      req.log.info({ lang, pid: handle.process.pid }, 'lsp ws: connected');

      const adapter = adaptSocket(socket);
      const dispose = handle.pipeToWebSocket(adapter);

      socket.on('close', (code, reason) => {
        req.log.info(
          { lang, pid: handle.process.pid, code, reason: reason.toString('utf8') },
          'lsp ws: disconnected',
        );
        dispose();
      });
      socket.on('error', (err: Error) => {
        req.log.warn({ err: err.message, lang }, 'lsp ws: socket error');
        dispose();
      });
    },
  );
}
