import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  getCurrentWorktreeContext,
  getWorktreePath,
  resolveSafe,
} from '../workspace.js';
import { binAvailable } from '../util/bin.js';
import { buildCleanEnv } from '../util/env.js';
import { buildBwrapArgs, bwrapAvailable, wrapWithDropPriv } from '../util/sandbox.js';
import { findProcessOnPort, waitPortFree } from '../util/port.js';
import { env } from '../lib/env.js';
import { runtimeState } from '../runtime-state.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** P6: Ring buffer cap para stdout/stderr de processos em background.
 * Previne memory leak quando dev servers rodam por horas acumulando logs. */
const BG_OUTPUT_CAP = 512 * 1024; // 512KB por stream

/** Anexa data ao ring buffer, removendo bytes antigos do início quando excede o cap. */
function appendCapped(str: string, chunk: string): string {
  const combined = str + chunk;
  if (combined.length > BG_OUTPUT_CAP) {
    return combined.slice(combined.length - BG_OUTPUT_CAP);
  }
  return combined;
}

interface BgProc {
  id: string;
  scopeName: string;
  cmd: string;
  cwd: string;
  /** Identificador idempotente. Se setado, `start_process` mata processo prévio
   *  com mesmo label antes de subir o novo. Pensado pra dev servers de
   *  exposed services (label = nome do service). */
  label?: string;
  /** Porta que o processo abre, quando aplicável. Informativo — não muda
   *  comportamento aqui. `restart_managed_process` (F1.3) usa pra matar por
   *  porta também. */
  port?: number;
  child: ChildProcess;
  stdout: string;
  stderr: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  exitCode: number | null;
  startedAt: number;
  /** Worktree (chat) que iniciou o processo — chave de segmentação. */
  worktreeKey: string;
}

const bgProcesses = new Map<string, BgProc>();

const SANDBOX = {
  memoryMax: env.limits.memoryMax,
  memoryHigh: env.limits.memoryHigh,
  cpuQuota: env.limits.cpuQuota,
  tasksMax: env.limits.tasksMaxStr,
};

async function useSystemdScope(): Promise<boolean> {
  return await binAvailable('systemd-run');
}

/**
 * Mata UM processo individualmente: marca como 'killed', stop do scope systemd
 * (se aplicável), depois SIGKILL no child. No-op se não estiver rodando.
 *
 * Extraído pra reuso entre `kill_process` (tool MCP), a lógica de
 * label-collision em `start_process`, e `restart_managed_process` (F1.3).
 */
async function killOne(p: BgProc): Promise<void> {
  if (p.status !== 'running') return;
  p.status = 'killed';
  const limited = await useSystemdScope();
  if (limited) {
    await new Promise<void>((resolve) => {
      const s = spawn('systemctl', ['--user', 'stop', p.scopeName], { stdio: 'ignore' });
      s.on('close', () => resolve());
      s.on('error', () => resolve());
    });
  }
  try {
    p.child.kill('SIGKILL');
  } catch {}
}

export function killAllBgProcesses(): void {
  for (const [, p] of bgProcesses) {
    if (p.status === 'running') {
      spawn('systemctl', ['--user', 'stop', p.scopeName], { stdio: 'ignore' }).on('error', () => {});
      try {
        p.child.kill('SIGKILL');
      } catch {}
    }
  }
}

const okJson = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj) }] });
const errResp = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true });

export interface SpawnManagedResult {
  processId: string;
  label?: string;
  port?: number;
  sandboxed: boolean;
  isolated: boolean;
  scopeName?: string;
  sandboxLimits?: typeof SANDBOX;
  pid?: number;
  status: BgProc['status'];
  cmd: string;
  cwd: string;
  stdoutPreview: string;
  stderrPreview: string;
}

/**
 * Spawn de processo gerenciado (cgroup via systemd-scope + namespaces via bwrap
 * quando disponíveis). Registra no `bgProcesses` Map e devolve o payload de
 * resposta padronizado.
 *
 * Extraído pra reuso entre `start_process` (com label-collision opcional) e
 * `restart_managed_process` (que adiciona descoberta+kill por porta antes).
 * Não faz a label-collision aqui — caller decide.
 */
async function spawnManaged(opts: {
  cmd: string;
  cwd?: string;
  label?: string;
  port?: number;
}): Promise<SpawnManagedResult> {
  const { cmd, cwd, label, port } = opts;
  const workDir = cwd ? resolveSafe(cwd) : getWorktreePath();
  const id = randomUUID().slice(0, 8);
  const scopeName = `sandbox-proc-${id}.scope`;
  const limited = await useSystemdScope();
  const isolated = await bwrapAvailable();
  const cleanEnv = buildCleanEnv();

  let bin: string;
  let args: string[];
  const leafCmd = await wrapWithDropPriv(['bash', '--norc', '--noprofile', '-c', cmd]);
  const bwrapArgs = isolated ? buildBwrapArgs({ cwd: workDir, env: cleanEnv }) : null;

  if (limited && isolated) {
    // systemd-run (cgroup limits) + bwrap (namespaces)
    bin = 'systemd-run';
    args = [
      '--user', '--scope', `--unit=${scopeName}`,
      `--property=MemoryMax=${SANDBOX.memoryMax}`,
      `--property=MemoryHigh=${SANDBOX.memoryHigh}`,
      `--property=CPUQuota=${SANDBOX.cpuQuota}`,
      `--property=TasksMax=${SANDBOX.tasksMax}`,
      '--quiet', '--collect',
      'bwrap', ...bwrapArgs!, '--', ...leafCmd,
    ];
  } else if (limited) {
    // só cgroup (sem bwrap disponível)
    bin = 'systemd-run';
    args = [
      '--user', '--scope', `--unit=${scopeName}`,
      `--property=MemoryMax=${SANDBOX.memoryMax}`,
      `--property=MemoryHigh=${SANDBOX.memoryHigh}`,
      `--property=CPUQuota=${SANDBOX.cpuQuota}`,
      `--property=TasksMax=${SANDBOX.tasksMax}`,
      '--quiet', '--collect', '--working-directory', workDir,
      ...leafCmd,
    ];
  } else if (isolated) {
    // só namespaces (sem systemd — ambiente não tem systemd-run)
    bin = 'bwrap';
    args = [...bwrapArgs!, '--', ...leafCmd];
  } else {
    // fallback cru
    bin = 'bash';
    args = ['-c', cmd];
  }

  const child = spawn(bin, args, {
    cwd: workDir,
    env: cleanEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.unref();

  const proc: BgProc = {
    id,
    scopeName,
    cmd,
    cwd: workDir,
    label,
    port,
    child,
    stdout: '',
    stderr: '',
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    // Worktree (chat) dono deste processo. Usado pra segmentar list/ownership
    // e a colisão de label — antes era tudo global e um chat via/matava
    // processos de outro. getWorktreePath() nunca é undefined (cai em
    // MAIN_WORKTREE p/ chats legacy). Ver docs/proposta P1-estado-global-sandbox.
    worktreeKey: getWorktreePath(),
  };
  bgProcesses.set(id, proc);

  child.stdout?.on('data', (d) => (proc.stdout = appendCapped(proc.stdout, d.toString())));
  child.stderr?.on('data', (d) => (proc.stderr = appendCapped(proc.stderr, d.toString())));
  child.on('close', (code) => {
    proc.exitCode = code;
    proc.status = code === 0 ? 'completed' : proc.status === 'killed' ? 'killed' : 'failed';
  });
  child.on('error', (e) => {
    proc.stderr += `[spawn error] ${e.message}\n`;
    proc.status = 'failed';
  });

  // P7: Removido delay artificial de 500ms.
  // A IA consulta get_process_output depois se precisar ver o status inicial.

  return {
    processId: id,
    label,
    port,
    sandboxed: limited,
    isolated,
    scopeName: limited ? scopeName : undefined,
    sandboxLimits: limited ? SANDBOX : undefined,
    pid: child.pid,
    status: proc.status,
    cmd,
    cwd: workDir,
    stdoutPreview: proc.stdout.slice(0, 500),
    stderrPreview: proc.stderr.slice(0, 500),
  };
}

// ── Helpers públicos (reusáveis por tools MCP E rotas REST) ───────────────

export interface ManagedProcessSummary {
  processId: string;
  label?: string;
  port?: number;
  pid: number | undefined;
  cmd: string;
  cwd: string;
  status: BgProc['status'];
  exitCode: number | null;
  elapsedMs: number;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface ProcessOutputPayload {
  processId: string;
  status: BgProc['status'];
  exitCode: number | null;
  elapsedMs: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
}

export function listManagedProcesses(): ManagedProcessSummary[] {
  // Segmentado por worktree: um chat só vê os PRÓPRIOS processos (antes
  // vazava a lista inteira do container — ids de outros chats). Ver
  // docs/proposta P1-estado-global-sandbox.
  const here = getWorktreePath();
  return Array.from(bgProcesses.values())
    .filter((p) => p.worktreeKey === here)
    .map((p) => ({
    processId: p.id,
    label: p.label,
    port: p.port,
    pid: p.child.pid,
    cmd: p.cmd,
    cwd: p.cwd,
    status: p.status,
    exitCode: p.exitCode,
    elapsedMs: Date.now() - p.startedAt,
    stdoutBytes: p.stdout.length,
    stderrBytes: p.stderr.length,
  }));
}

export function getManagedProcessOutput(
  processId: string,
  tailLines = 50,
): ProcessOutputPayload | null {
  const p = bgProcesses.get(processId);
  if (!p) return null;
  const tailOf = (s: string, n: number) => s.split('\n').slice(-n).join('\n');
  return {
    processId,
    status: p.status,
    exitCode: p.exitCode,
    elapsedMs: Date.now() - p.startedAt,
    stdout: tailOf(p.stdout, tailLines),
    stderr: tailOf(p.stderr, tailLines),
    stdoutBytes: p.stdout.length,
    stderrBytes: p.stderr.length,
  };
}

export type KillResult =
  | { ok: true; processId: string; status: BgProc['status']; scopeStopped?: boolean; note?: string }
  | { ok: false; code: 'NOT_FOUND'; processId: string };

export async function killManagedProcess(processId: string): Promise<KillResult> {
  const p = bgProcesses.get(processId);
  if (!p) return { ok: false, code: 'NOT_FOUND', processId };
  if (p.status !== 'running') {
    return { ok: true, processId, status: p.status, note: 'já não estava rodando' };
  }
  await killOne(p);
  const limited = await useSystemdScope();
  return { ok: true, processId, status: 'killed', scopeStopped: limited };
}

export interface RestartManagedOpts {
  label: string;
  cmd: string;
  port?: number;
  cwd?: string;
}

export type RestartResult =
  | { ok: true; result: SpawnManagedResult }
  | { ok: false; error: string; code: 'PORT_BUSY' | 'INTERNAL' };

export async function restartManagedProcess(
  opts: RestartManagedOpts,
): Promise<RestartResult> {
  try {
    // 1. Mata por label dentro do nosso Map — SÓ no worktree atual (a colisão
    //    de label não deve matar o dev server de outro chat). Ver docs/proposta
    //    P1-estado-global-sandbox.
    const here = getWorktreePath();
    for (const [, existing] of bgProcesses) {
      if (
        existing.label === opts.label &&
        existing.status === 'running' &&
        existing.worktreeKey === here
      ) {
        await killOne(existing);
      }
    }
    // 2. Mata por porta (cobre processo fora do Map). GLOBAL de propósito: só
    //    um worktree serve uma porta por vez (invariante do runtime).
    if (opts.port !== undefined) {
      const onPort = await findProcessOnPort(opts.port);
      if (onPort) {
        try {
          process.kill(onPort.pid, 'SIGKILL');
        } catch {
          /* PID já morto entre find e kill — tudo bem */
        }
        const freed = await waitPortFree(opts.port, 5000);
        if (!freed) {
          return {
            ok: false,
            code: 'PORT_BUSY',
            error: `porta ${opts.port} ainda ocupada após 5s tentando liberar (PID ${onPort.pid}). Abortando restart.`,
          };
        }
      }
    }
    // 3. Spawna o novo.
    const result = await spawnManaged({
      cmd: opts.cmd,
      cwd: opts.cwd,
      label: opts.label,
      port: opts.port,
    });
    return { ok: true, result };
  } catch (e) {
    return {
      ok: false,
      code: 'INTERNAL',
      error: (e as Error).message,
    };
  }
}

export interface StartProcessOpts {
  cmd: string;
  cwd?: string;
  label?: string;
  port?: number;
}

export async function startManagedProcess(
  opts: StartProcessOpts,
): Promise<SpawnManagedResult> {
  // Label-collision: mata processo prévio com mesmo label — SÓ no worktree
  // atual (não derruba o de outro chat). Ver docs/proposta P1-estado-global-sandbox.
  if (opts.label) {
    const here = getWorktreePath();
    for (const [, existing] of bgProcesses) {
      if (
        existing.label === opts.label &&
        existing.status === 'running' &&
        existing.worktreeKey === here
      ) {
        await killOne(existing);
      }
    }
  }
  return await spawnManaged({
    cmd: opts.cmd,
    cwd: opts.cwd,
    label: opts.label,
    port: opts.port,
  });
}

// ── Active runtime worktree (Fase 2 — Design A1) ─────────────────────────

export interface ExposedServiceDef {
  name: string;
  port: number;
  startCommand: string;
}

export interface MakeWorktreeActiveResult {
  activeWorktreePath: string;
  activeConversationId: string | null;
  started: { name: string; port: number; processId: string }[];
  /** Services que não conseguiram subir (start_process falhou). */
  failed: { name: string; error: string }[];
}

/**
 * Swap atômico do "active runtime worktree": mata todo o stack que estava
 * rodando, espera as portas dos novos services liberarem, e sobe os
 * exposed services no worktree atual (do request).
 *
 * Pré-condição: o request deve ter um worktree context populado (header
 * `X-Sandbox-Worktree`). Se ausente, opera no MAIN_WORKTREE (chat legacy).
 */
export async function makeMyWorktreeActive(opts: {
  exposedServices: ExposedServiceDef[];
}): Promise<MakeWorktreeActiveResult> {
  const myWorktree = getWorktreePath();
  const ctx = getCurrentWorktreeContext();

  // 1. Mata tudo do stack ativo atual (qualquer service registrado).
  const killed: string[] = [];
  for (const [, processId] of runtimeState.activeServices) {
    const p = bgProcesses.get(processId);
    if (p && p.status === 'running') {
      await killOne(p);
      killed.push(processId);
    }
  }
  // Defensivo: também mata qualquer processo com label igual a algum
  // exposed service mas que NÃO esteja no activeServices map (race ou
  // crash no swap anterior).
  const wantedLabels = new Set(opts.exposedServices.map((s) => s.name));
  for (const [, p] of bgProcesses) {
    if (p.status === 'running' && p.label && wantedLabels.has(p.label)) {
      await killOne(p);
      killed.push(p.id);
    }
  }
  runtimeState.activeServices.clear();

  // 2. Espera as portas liberarem (todas em paralelo).
  await Promise.all(
    opts.exposedServices.map((s) => waitPortFree(s.port, 5000)),
  );

  // 3. Atualiza state e sobe o novo stack.
  runtimeState.activeWorktreePath = myWorktree;
  runtimeState.activeConversationId = ctx?.conversationId ?? null;
  runtimeState.startedAt = Date.now();

  const started: MakeWorktreeActiveResult['started'] = [];
  const failed: MakeWorktreeActiveResult['failed'] = [];
  for (const svc of opts.exposedServices) {
    try {
      const r = await spawnManaged({
        cmd: svc.startCommand,
        cwd: myWorktree,
        label: svc.name,
        port: svc.port,
      });
      runtimeState.activeServices.set(svc.name, r.processId);
      started.push({ name: svc.name, port: svc.port, processId: r.processId });
    } catch (e) {
      failed.push({ name: svc.name, error: (e as Error).message });
    }
  }

  return {
    activeWorktreePath: myWorktree,
    activeConversationId: ctx?.conversationId ?? null,
    started,
    failed,
  };
}

/**
 * Mata todos os processos do stack ativo e limpa o state. Não toca em
 * processos que não estão no `activeServices` map (preserva tarefas
 * pontuais que o agente subiu via `start_process`).
 */
export async function stopActiveRuntime(): Promise<{ stopped: string[] }> {
  const stopped: string[] = [];
  for (const [label, processId] of runtimeState.activeServices) {
    const p = bgProcesses.get(processId);
    if (p && p.status === 'running') {
      await killOne(p);
      stopped.push(label);
    }
  }
  runtimeState.activeServices.clear();
  runtimeState.activeWorktreePath = null;
  runtimeState.activeConversationId = null;
  runtimeState.startedAt = null;
  return { stopped };
}

// ── Registro das tools MCP — delega aos helpers ──────────────────────────

export function registerProcessTools(server: McpServer): void {
  server.registerTool(
    'start_process',
    {
      description:
        'Inicia um processo em BACKGROUND sandboxado (systemd scope quando disponível, com limite de memória/CPU). Retorna processId pra acompanhar via get_process_output e kill_process. Use pra comandos longos (npm install, dev servers). Aceita `label` opcional: se já existe processo rodando com o mesmo label, ele é morto antes do novo subir (idempotência).',
      inputSchema: {
        cmd: z.string().describe('Comando bash (ex.: "npm install", "npm run dev")'),
        cwd: z.string().optional().describe('Subdiretório relativo ao workspace'),
        label: z.string().optional().describe('Identificador idempotente. Se já existe processo rodando com mesmo label, ele é morto antes do novo subir. Use o nome do exposed service (ex.: "web", "api").'),
        port: z.number().optional().describe('Porta que esse processo vai abrir. Informativo aqui — pra matar processos por porta use restart_managed_process.'),
      },
    },
    async ({ cmd, cwd, label, port }) => {
      try {
        const result = await startManagedProcess({ cmd, cwd, label, port });
        return okJson(result);
      } catch (e) {
        return errResp(`start_process falhou: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'restart_managed_process',
    {
      description:
        'Para qualquer processo rodando com o mesmo `label` OU bound na `port` informada, aguarda a porta liberar, e sobe novo processo. Atomic e idempotente — chamadas repetidas com mesmo label sempre resultam em UM processo rodando com aquele label. Use SEMPRE pra dev servers de exposed services do projeto (label = nome do exposed service).',
      inputSchema: {
        label: z.string().describe('Identificador do processo gerenciado (ex.: nome do exposed service "web", "api"). Obrigatório.'),
        cmd: z.string().describe('Comando bash a executar (ex.: "npm run dev").'),
        port: z.number().optional().describe('Porta que o processo vai abrir. Se fornecida, processos NÃO gerenciados bound nessa porta também são mortos antes do spawn.'),
        cwd: z.string().optional().describe('Subdiretório relativo ao workspace.'),
      },
    },
    async ({ label, cmd, port, cwd }) => {
      const r = await restartManagedProcess({ label, cmd, port, cwd });
      if (!r.ok) return errResp(`restart_managed_process falhou: ${r.error}`);
      return okJson(r.result);
    },
  );

  server.registerTool(
    'get_process_output',
    {
      description:
        'Lê o output acumulado de um processo em background. Retorna status, últimas N linhas de stdout/stderr, exitCode.',
      inputSchema: {
        processId: z.string(),
        tailLines: z.number().optional().default(50),
      },
    },
    async ({ processId, tailLines }) => {
      const out = getManagedProcessOutput(processId, tailLines ?? 50);
      if (!out) return errResp(`processId ${processId} não encontrado`);
      return okJson(out);
    },
  );

  server.registerTool(
    'kill_process',
    {
      description:
        'Mata um processo em background (SIGKILL). Se estiver sandboxado, mata o scope inteiro (todos os sub-processos).',
      inputSchema: { processId: z.string() },
    },
    async ({ processId }) => {
      const r = await killManagedProcess(processId);
      if (!r.ok) return errResp(`processId ${processId} não encontrado`);
      return okJson(r);
    },
  );

  server.registerTool(
    'list_processes',
    {
      description: 'Lista todos os processos em background com status, pid, cmd e bytes de output.',
      inputSchema: {},
    },
    async () => {
      return okJson({ processes: listManagedProcesses() });
    },
  );

  server.registerTool(
    'make_my_worktree_active',
    {
      description:
        'Faz o swap atômico do "active runtime worktree": mata todos os exposed services rodando (de qualquer chat) e sobe os do projeto no worktree DESTE chat. Use quando o usuário pedir pra rodar/iniciar/testar o PROJETO INTEIRO. Pra reiniciar um único service específico, use restart_managed_process.',
      inputSchema: {
        exposedServices: z
          .array(
            z.object({
              name: z.string().describe('Nome do exposed service (vira label)'),
              port: z.number().int().min(1).max(65535),
              startCommand: z.string().describe('Comando bash pra iniciar o service'),
            }),
          )
          .describe('Lista dos exposed services do projeto. Use exatamente o que vem da configuração do projeto (### Como rodar/parar/reiniciar do system prompt).'),
      },
    },
    async ({ exposedServices }) => {
      try {
        const r = await makeMyWorktreeActive({ exposedServices });
        return okJson(r);
      } catch (e) {
        return errResp(`make_my_worktree_active falhou: ${(e as Error).message}`);
      }
    },
  );
}
