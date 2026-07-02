import { FastifyPluginAsync, FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import websocket from '@fastify/websocket';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import fsRoutes from './routes/fs.js';
import gitRoutes from './routes/git.js';
import workspaceRoutes from './routes/workspace.js';
import execRoutes from './routes/exec.js';
import ripgrepRoutes from './routes/ripgrep.js';
import processRoutes from './routes/processes.js';
import worktreeRoutes from './routes/worktree.js';
import mainSyncRoutes from './routes/main-sync.js';
import runtimeRoutes from './routes/runtime.js';
import mergeFlowRoutes from './routes/merge-flow.js';
import pushChatBranchRoutes from './routes/git-push-chat.js';

const apiPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Sandbox Agent API',
        version: '1.0.0',
        description: 'REST API do sandbox-agent. Filesystem, git, workspace info, file watcher (WebSocket).',
      },
      servers: [{ url: '/api/v1' }],
      components: {
        securitySchemes: {
          bearer: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'opaque (SANDBOX_TOKEN) ou JWT (do AppCore via gateway)',
          },
        },
      },
      security: [{ bearer: [] }],
    },
  });

  await app.register(async (v1) => {
    const typed = v1.withTypeProvider<TypeBoxTypeProvider>();
    await typed.register(fsRoutes);
    await typed.register(gitRoutes);
    await typed.register(workspaceRoutes);
    await typed.register(execRoutes);
    await typed.register(ripgrepRoutes);
    await typed.register(processRoutes);
    await typed.register(worktreeRoutes);
    await typed.register(mainSyncRoutes);
    await typed.register(runtimeRoutes);
    await typed.register(mergeFlowRoutes);
    await typed.register(pushChatBranchRoutes);
  }, { prefix: '/api/v1' });

  // OpenAPI JSON spec — público (auth hook libera /api/v1/openapi.json)
  app.get('/api/v1/openapi.json', async () => app.swagger());

  // Docs UI — acessível em /api/v1/docs
  // @scalar/fastify-api-reference types are incomplete; cast to any to use spec.url
  await app.register(scalar, {
    routePrefix: '/api/v1/docs',
    configuration: {
      theme: 'kepler',
      spec: {
        url: '/api/v1/openapi.json',
      },
    } as any,
  });
};

export default apiPlugin;