import { spawn } from 'node:child_process';
import path from 'node:path';
import { safePath } from './service.js';
import { binAvailable } from '../util/bin.js';
import { getWorktreePath } from '../workspace.js';

export interface SearchMatch {
  file: string;
  line?: number;
  column?: number;
  text?: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
  tool: 'ripgrep' | 'grep/find';
  /** True quando o processo foi morto por timeout. */
  timedOut?: boolean;
}

/** Hard cap no buffer acumulado (proteção contra rg cuspindo MB e travando). */
const MAX_OUT_BYTES = 5 * 1024 * 1024; // 5 MB
/** Default de timeout do processo filho. Configurável via SEARCH_TIMEOUT_MS. */
const DEFAULT_TIMEOUT_MS = parseInt(process.env.SEARCH_TIMEOUT_MS ?? '30000', 10);

/** Normaliza path retornado pela busca para ser relativo ao workspace root. */
function toWorkspaceRelative(p: string): string {
  const wt = getWorktreePath();
  const abs = path.isAbsolute(p) ? p : path.resolve(getSearchCwd(), p);
  let rel = path.relative(wt, abs);
  if (rel.startsWith('..')) rel = p; // fallback: não conseguiu normalizar
  return rel || '.';
}

/** CWD da busca atual (setado antes do spawn, usado no post-process). */
let _searchCwd = '.';
function getSearchCwd(): string {
  return _searchCwd;
}

export async function searchFiles(
  pattern: string,
  opts: {
    onlyNames?: boolean;
    path?: string;
    caseInsensitive?: boolean;
    maxResults?: number;
    timeoutMs?: number;
  } = {},
): Promise<SearchResult> {
  const cwd = safePath(opts.path ?? '.');
  _searchCwd = cwd;
  const max = opts.maxResults ?? 200;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const hasRg = await binAvailable('rg');
  return new Promise((resolve) => {
    let bin: string;
    let args: string[];
    if (hasRg) {
      bin = 'rg';
      if (opts.onlyNames) {
        // --files lista todos os arquivos; filtramos por pattern via --glob
        // quando pattern tem wildcards, ou via -F (fixed-string) no path
        // quando é um nome literal de arquivo.
        args = ['--files', '-N'];
        if (/[*?\[\]]/.test(pattern)) {
          // pattern é um glob (ex.: "*.ts", "src/**/*.vue")
          args.push('--glob', pattern);
        } else {
          // pattern é um nome literal — usar -g com wildcard
          args.push('--glob', `*${pattern}*`);
        }
      } else {
        args = ['--vimgrep', '--no-heading', '--max-count', '10', '--max-columns', '300'];
        if (opts.caseInsensitive) args.push('-i');
        args.push(pattern);
      }
    } else if (opts.onlyNames) {
      bin = 'bash';
      const findPattern = /[*?\[\]]/.test(pattern) ? pattern : `*${pattern}*`;
      args = ['-c', `find . -type f -name ${JSON.stringify(findPattern)} | head -n ${max}`];
    } else {
      bin = 'bash';
      args = ['-c', `grep -rn ${opts.caseInsensitive ? '-i ' : ''}${JSON.stringify(pattern)} . | head -n ${max}`];
    }
    const proc = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    // Estado da Promise: garante resolve único.
    let done = false;
    const finish = (result: SearchResult) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      resolve(result);
    };

    // Buffer com cap — para de acumular após MAX_OUT_BYTES e mata o processo
    // (rg já produziu o suficiente; manter ele rodando só atrasa o retorno).
    let out = '';
    let bufferFull = false;
    const appendOut = (chunk: string) => {
      if (bufferFull) return;
      out += chunk;
      if (out.length >= MAX_OUT_BYTES) {
        bufferFull = true;
        out = out.slice(0, MAX_OUT_BYTES);
        try { proc.kill('SIGTERM'); } catch {}
      }
    };
    proc.stdout.on('data', (d) => appendOut(d.toString()));
    proc.stderr.on('data', (d) => appendOut(d.toString()));

    // Timeout duro: se o processo travar, mata e resolve com timedOut: true.
    // Sem isso o handler MCP fica esperando indefinidamente.
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      finish({
        matches: [],
        truncated: false,
        tool: hasRg ? 'ripgrep' : 'grep/find',
        timedOut: true,
      });
    }, timeoutMs);

    proc.on('close', () => {
      const lines = out.split('\n').filter(Boolean);
      const matches = lines.slice(0, max).map((line): SearchMatch => {
        // --files mode: cada linha é só um path
        if (opts.onlyNames) {
          return { file: toWorkspaceRelative(line.trim()) };
        }
        const m = /^([^:]+):(\d+):(?:(\d+):)?(.*)$/.exec(line);
        if (m) {
          return {
            file: toWorkspaceRelative(m[1]),
            line: parseInt(m[2], 10),
            column: m[3] ? parseInt(m[3], 10) : undefined,
            text: m[4],
          };
        }
        return { file: toWorkspaceRelative(line) };
      });
      finish({
        matches,
        truncated: lines.length > max || bufferFull,
        tool: hasRg ? 'ripgrep' : 'grep/find',
      });
    });
    proc.on('error', () => finish({
      matches: [],
      truncated: false,
      tool: hasRg ? 'ripgrep' : 'grep/find',
    }));
  });
}
