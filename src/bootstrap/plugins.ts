import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { extractBearerToken, extractTokenWithFallback, validateToken } from '../middlewares/auth.js';
import { env } from '../lib/env.js';
import { sessions } from '../mcp/sessions.js';
import {
  enterWorktreeContext,
  MAIN_WORKTREE,
  resolveWorktreePath,
} from '../workspace.js';

export async function registerPlugins(app: FastifyInstance): Promise<void> {
  // Rate limit existe pra blindar a sandbox contra tráfego não autenticado
  // ou abusivo. As rotas `/mcp/*` e `/api/v1/*` são o caminho normal de
  // operação do agente (filesystem/shell/process) e ficam atrás do gateway
  // com JWT validado — então são allowlistadas: um agente AI legítimo
  // dispara facilmente centenas de tool calls em poucos segundos quando
  // está editando código, e estourar o limite vira `aborted` no cliente.
  //
  // O limite ainda protege rotas eventuais sem auth (ex.: as docs já
  // allowlistadas explicitamente) e qualquer endpoint futuro que não
  // esteja sob `/mcp` ou `/api/v1/`.
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    keyGenerator: (req: FastifyRequest) => req.ip,
    allowList: (req: FastifyRequest) =>
      req.url === '/health' ||
      req.url.startsWith('/mcp') ||
      req.url.startsWith('/api/v1/'),
  });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const isOpenApi = req.url.startsWith('/api/v1/openapi.json');
    const isDocs = req.url.startsWith('/api/v1/docs');
    if (isOpenApi || isDocs) return;

    const isMcp = req.url.startsWith('/mcp');
    const isApi = req.url.startsWith('/api/');
    if (!isMcp && !isApi) return;

    const isWatch = req.method === 'GET' && req.url.startsWith('/api/v1/fs/watch');
    const token = isWatch ? extractTokenWithFallback(req) : extractBearerToken(req);

    if (!token) {
      return reply.code(401).send({ error: 'Authorization ausente' });
    }
    if (!validateToken(token)) {
      // Mensagem distinta de "token inválido" (que é o que o gateway devolve
      // pra JWT do usuário). Aqui é o internal_token gateway↔sandbox-agent:
      // se isso falha, o sandbox foi recriado/redeployado e a row no DB do
      // gateway tem um internal_token divergente do SANDBOX_TOKEN do
      // container — bug de provisionamento, não de auth de usuário.
      return reply.code(403).send({ error: 'sandbox_token_invalid' });
    }

    delete req.headers['x-user-id'];
    delete req.headers['x-org-id'];

    // ── Worktree context (Fase 2) ─────────────────────────────────────
    // Header opcional `X-Sandbox-Worktree: <conversationId>`. Quando
    // presente, popula o ALS pra que tools/routes operem em /wt/<id> em
    // vez de MAIN_WORKTREE. Ausência = compat com clientes velhos / ops
    // globais (main fetch/pull, merge).
    const wtHeader = req.headers['x-sandbox-worktree'];
    const wtId = typeof wtHeader === 'string' ? wtHeader.trim() : '';
    if (wtId) {
      try {
        const wtPath = resolveWorktreePath(wtId);
        enterWorktreeContext({ worktreePath: wtPath, conversationId: wtId });
      } catch (err) {
        req.log.warn(
          { wtId, err: (err as Error).message },
          '[worktree] header X-Sandbox-Worktree inválido — ignorado',
        );
        // Não bloqueia a request — opera em MAIN_WORKTREE como fallback.
        enterWorktreeContext({ worktreePath: MAIN_WORKTREE });
      }
    } else {
      enterWorktreeContext({ worktreePath: MAIN_WORKTREE });
    }
  });
}

export function registerHealthcheck(app: FastifyInstance): void {
  app.get('/health', async () => ({
    ok: true,
    workspace: env.workspace,
    sessions: sessions.size,
  }));
}
