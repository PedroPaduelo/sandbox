import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  StreamMessageReader,
  StreamMessageWriter,
  type Message,
} from 'vscode-jsonrpc/node.js';
import {
  WebSocketMessageReader,
  WebSocketMessageWriter,
  type IWebSocket,
} from 'vscode-ws-jsonrpc';
import { defaultReadRss, type ReadRssFn } from './memoryMonitor.js';

export type LspLanguage = 'typescript' | 'javascript';

export interface PoolLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface LspServerHandle {
  readonly language: string;
  readonly process: ChildProcessWithoutNullStreams;
  readonly createdAt: number;
  lastUsedAt: number;
  /**
   * Pipe bidirecional entre o IWebSocket e os stdin/stdout do processo LSP.
   * O disposer remove SOMENTE os listeners criados neste pipe — o processo
   * continua vivo (gerenciado pelo pool).
   */
  pipeToWebSocket(ws: IWebSocket): () => void;
}

export interface LspServerPoolOptions {
  workspaceRoot: string;
  maxServers?: number;
  idleTimeoutMs?: number;
  memoryLimitBytes?: number;
  memoryCheckIntervalMs?: number;
  logger: PoolLogger;
  /** Injetável p/ tests — leitor de RSS por pid. */
  readRss?: ReadRssFn;
  /**
   * Injetável p/ tests — spawner do server LSP. Útil pra trocar pelo mock
   * echo nos tests sem precisar do typescript-language-server real.
   */
  spawnServer?: (language: LspLanguage, cwd: string) => ChildProcessWithoutNullStreams;
}

interface PoolEntry {
  language: string;
  handle: LspServerHandle;
}

const DEFAULTS = {
  maxServers: 3,
  idleTimeoutMs: 5 * 60_000,
  memoryLimitBytes: 500 * 1024 * 1024,
  memoryCheckIntervalMs: 30_000,
} as const;

/**
 * Resolve o caminho do CLI do `typescript-language-server` instalado como
 * dependência runtime. Usa `createRequire` pra funcionar tanto em ESM (dev,
 * `tsx`) quanto no CJS bundle gerado pelo tsup.
 */
function resolveTsServerCli(): string {
  const req = createRequire(import.meta.url);
  return req.resolve('typescript-language-server/lib/cli.mjs');
}

function defaultSpawnServer(language: LspLanguage, cwd: string): ChildProcessWithoutNullStreams {
  // typescript-language-server distribui um CLI Node — invocamos via `node`
  // pra evitar depender de shebang/permissions no container e funcionar em
  // Alpine/Debian igualmente.
  const cli = resolveTsServerCli();
  const args = [cli, '--stdio'];
  // O server roda o tsserver internamente; `language` define apenas o subset
  // mas o server lida com TS+JS no mesmo processo. Mantemos um por linguagem
  // pra simplificar isolation de workspace settings no futuro.
  return spawn(process.execPath, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LSP_LANG: language },
  });
}

export class LspServerPool {
  private readonly entries: PoolEntry[] = [];
  private readonly opts: Required<Omit<LspServerPoolOptions, 'logger' | 'readRss' | 'spawnServer'>> & {
    logger: PoolLogger;
    readRss: ReadRssFn;
    spawnServer: (language: LspLanguage, cwd: string) => ChildProcessWithoutNullStreams;
  };
  private readonly idleTimer: NodeJS.Timeout;
  private readonly memoryTimer: NodeJS.Timeout;
  private disposed = false;

  constructor(options: LspServerPoolOptions) {
    this.opts = {
      workspaceRoot: options.workspaceRoot,
      maxServers: options.maxServers ?? DEFAULTS.maxServers,
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
      memoryLimitBytes: options.memoryLimitBytes ?? DEFAULTS.memoryLimitBytes,
      memoryCheckIntervalMs: options.memoryCheckIntervalMs ?? DEFAULTS.memoryCheckIntervalMs,
      logger: options.logger,
      readRss: options.readRss ?? defaultReadRss,
      spawnServer: options.spawnServer ?? defaultSpawnServer,
    };

    const idleInterval = Math.max(1_000, Math.floor(this.opts.idleTimeoutMs / 5));
    this.idleTimer = setInterval(() => this.checkIdle(), idleInterval);
    this.idleTimer.unref?.();

    this.memoryTimer = setInterval(() => {
      this.checkMemory().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.opts.logger.warn({ err: msg }, 'lsp memory check failed');
      });
    }, this.opts.memoryCheckIntervalMs);
    this.memoryTimer.unref?.();
  }

  async acquire(language: LspLanguage): Promise<LspServerHandle> {
    if (this.disposed) throw new Error('LspServerPool disposed');

    const found = this.entries.find((e) => e.language === language);
    if (found) {
      found.handle.lastUsedAt = Date.now();
      return found.handle;
    }

    if (this.entries.length >= this.opts.maxServers) {
      this.evictLru();
    }

    const proc = this.opts.spawnServer(language, this.opts.workspaceRoot);
    const handle: LspServerHandle = this.buildHandle(language, proc);
    this.entries.push({ language, handle });

    this.opts.logger.info(
      { language, pid: proc.pid, poolSize: this.entries.length },
      'lsp spawn',
    );

    proc.on('exit', (code, signal) => {
      this.opts.logger.info({ language, pid: proc.pid, code, signal }, 'lsp exit');
      this.removeEntry(language);
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.opts.logger.warn({ language, pid: proc.pid, stderr: text }, 'lsp stderr');
    });

    return handle;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.idleTimer);
    clearInterval(this.memoryTimer);
    const tasks = this.entries.map((e) => this.killEntry(e));
    this.entries.length = 0;
    await Promise.all(tasks);
  }

  // ── internals ───────────────────────────────────────────────────────────

  private buildHandle(
    language: string,
    proc: ChildProcessWithoutNullStreams,
  ): LspServerHandle {
    const now = Date.now();
    const handle: LspServerHandle = {
      language,
      process: proc,
      createdAt: now,
      lastUsedAt: now,
      pipeToWebSocket: (ws: IWebSocket) => this.pipe(handle, ws),
    };
    return handle;
  }

  private pipe(handle: LspServerHandle, ws: IWebSocket): () => void {
    const proc = handle.process;
    const wsReader = new WebSocketMessageReader(ws);
    const wsWriter = new WebSocketMessageWriter(ws);
    const procReader = new StreamMessageReader(proc.stdout);
    const procWriter = new StreamMessageWriter(proc.stdin);

    const fromClient = wsReader.listen((msg: Message) => {
      handle.lastUsedAt = Date.now();
      void procWriter.write(msg);
    });
    const fromServer = procReader.listen((msg: Message) => {
      handle.lastUsedAt = Date.now();
      void wsWriter.write(msg);
    });

    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      fromClient.dispose();
      fromServer.dispose();
      wsReader.dispose();
      // Não disposamos procReader/procWriter — quem possui é o pool.
    };
    return dispose;
  }

  private removeEntry(language: string): void {
    const idx = this.entries.findIndex((e) => e.language === language);
    if (idx >= 0) this.entries.splice(idx, 1);
  }

  private async killEntry(entry: PoolEntry): Promise<void> {
    const proc = entry.handle.process;
    if (proc.exitCode !== null || proc.killed) return;
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      proc.once('exit', done);
      try {
        proc.kill('SIGTERM');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.opts.logger.warn({ pid: proc.pid, err: msg }, 'lsp kill SIGTERM failed');
      }
      // Fallback SIGKILL após 2s pra evitar hang.
      const t = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.opts.logger.warn({ pid: proc.pid, err: msg }, 'lsp kill SIGKILL failed');
        }
        done();
      }, 2_000);
      t.unref?.();
    });
  }

  private evictLru(): void {
    if (this.entries.length === 0) return;
    let oldest = this.entries[0];
    if (!oldest) return;
    for (const e of this.entries) {
      if (e.handle.lastUsedAt < oldest.handle.lastUsedAt) oldest = e;
    }
    this.opts.logger.info(
      { language: oldest.language, pid: oldest.handle.process.pid },
      'lsp evict (LRU)',
    );
    void this.killEntry(oldest);
    this.removeEntry(oldest.language);
  }

  private checkIdle(): void {
    if (this.disposed) return;
    const now = Date.now();
    const dead: PoolEntry[] = [];
    for (const e of this.entries) {
      if (now - e.handle.lastUsedAt > this.opts.idleTimeoutMs) dead.push(e);
    }
    for (const e of dead) {
      this.opts.logger.info(
        { language: e.language, pid: e.handle.process.pid, idleMs: now - e.handle.lastUsedAt },
        'lsp idle evict',
      );
      void this.killEntry(e);
      this.removeEntry(e.language);
    }
  }

  private async checkMemory(): Promise<void> {
    if (this.disposed) return;
    const snapshot = this.entries.slice();
    for (const e of snapshot) {
      const pid = e.handle.process.pid;
      if (typeof pid !== 'number') continue;
      const rss = await this.opts.readRss(pid);
      if (rss === undefined) continue;
      if (rss > this.opts.memoryLimitBytes) {
        this.opts.logger.warn(
          { language: e.language, pid, rss, limit: this.opts.memoryLimitBytes },
          'lsp memory limit exceeded, killing',
        );
        await this.killEntry(e);
        this.removeEntry(e.language);
      }
    }
  }
}
