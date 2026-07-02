import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { env } from '../../lib/env.js';
import { bwrapAvailable } from '../../util/sandbox.js';
import { WorkspaceRes } from '../schemas/workspace.js';

const STACK_BINS = [
  'node', 'python3', 'git', 'rg',
  'rustc', 'go', 'java', 'php', 'deno', 'bun',
  'gcc', 'g++', 'make', 'cmake', 'ruby', 'lua',
];

interface StackInfo { available: boolean; version?: string }

let stackCache: { ts: number; data: Record<string, StackInfo> } | null = null;
const CACHE_TTL_MS = 60_000;

async function detectStack(bin: string): Promise<StackInfo> {
  return new Promise((resolve) => {
    const p = spawn(bin, ['--version']);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (out += d.toString()));
    const t = setTimeout(() => { p.kill('SIGKILL'); resolve({ available: false }); }, 2_000);
    p.on('error', () => { clearTimeout(t); resolve({ available: false }); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) return resolve({ available: false });
      const version = out.trim().split('\n')[0];
      resolve({ available: true, version });
    });
  });
}

async function detectAllStacks(): Promise<Record<string, StackInfo>> {
  if (stackCache && Date.now() - stackCache.ts < CACHE_TTL_MS) return stackCache.data;
  const entries = await Promise.all(
    STACK_BINS.map(async (b) => [b, await detectStack(b)] as const),
  );
  const data = Object.fromEntries(entries);
  stackCache = { ts: Date.now(), data };
  return data;
}

async function detectGitRepo(): Promise<{ isRepo: boolean; branch?: string }> {
  try {
    await fs.access(path.join(env.workspace, '.git'));
  } catch {
    return { isRepo: false };
  }
  const branch = await new Promise<string | undefined>((resolve) => {
    const p = spawn('git', ['-C', env.workspace, 'rev-parse', '--abbrev-ref', 'HEAD']);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    const t = setTimeout(() => { p.kill(); resolve(undefined); }, 2_000);
    p.on('error', () => { clearTimeout(t); resolve(undefined); });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve(code === 0 ? out.trim() : undefined);
    });
  });
  return { isRepo: true, branch };
}

const workspaceRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get('/workspace', {
    schema: { response: { 200: WorkspaceRes } },
  }, async () => {
    const [stacks, git, bwrap] = await Promise.all([
      detectAllStacks(),
      detectGitRepo(),
      bwrapAvailable().catch(() => false),
    ]);

    return {
      root: env.workspace,
      name: path.basename(env.workspace),
      hostname: os.hostname(),
      uptime: Math.floor(process.uptime()),
      stacks,
      limits: {
        memoryMaxBytes: env.limits.memoryMaxBytes,
        cpuQuotaPercent: env.limits.cpuQuotaPercent,
        tasksMax: env.limits.tasksMax,
      },
      isolation: { bwrap, uid: 1001 },
      git,
    };
  });
};

export default workspaceRoutes;
