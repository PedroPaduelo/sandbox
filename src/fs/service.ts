import fs from 'node:fs/promises';
import { createReadStream, type Stats } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { getWorktreePath, resolveSafe, toRelative, SANDBOX_UID, SANDBOX_GID } from '../workspace.js';

/**
 * BUG FIX (auditoria de produção): `fs.mkdir(..., { recursive: true })`
 * criava diretórios com owner root:root porque o processo do sandbox-agent
 * roda como root (precisa pra criar namespaces bwrap). `ensureWorkspace()`
 * só faz chown -R UMA VEZ no boot — qualquer diretório novo criado DEPOIS
 * (via fs_mkdir, fs_write em path com pasta nova, fs_move pra destino novo)
 * ficava root:root e quebrava a interop com run_command/start_process
 * (que rodam como uid 1001 via setpriv — "Permission denied" ao escrever
 * dentro dessas pastas).
 *
 * Cria os diretórios ausentes nível por nível (de fora pra dentro) e ajusta
 * ownership em cada um logo após criar — mesmo dono dos diretórios criados
 * no boot.
 */
async function mkdirChowned(dirPath: string): Promise<void> {
  const missing: string[] = [];
  let current = dirPath;
  // Sobe a árvore até achar o primeiro ancestral que já existe.
  for (;;) {
    try {
      await fs.access(current);
      break;
    } catch {
      missing.unshift(current);
      const parent = path.dirname(current);
      if (parent === current) break; // chegou na raiz do filesystem
      current = parent;
    }
  }
  // Cria em ordem (mais externo primeiro) e chowna cada nível criado.
  for (const dir of missing) {
    try {
      await fs.mkdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
    }
    try {
      await fs.chown(dir, SANDBOX_UID, SANDBOX_GID);
    } catch {
      // Non-fatal: se o chown falhar (ex.: rodando sem privilégio em dev
      // local), o diretório ainda foi criado — só não fica com o owner
      // ideal. Não deve bloquear a operação de fs_write/fs_mkdir/fs_move.
    }
  }
}

/**
 * Escrita ATÔMICA: grava num arquivo temp no MESMO diretório do alvo e renomeia.
 * `rename` é atômico no mesmo filesystem; manter o temp no mesmo dir evita
 * ENOTSUP de rename cross-device. `fs.writeFile` direto deixava o arquivo
 * truncado/corrompido se o container levasse SIGKILL (OOM/MemoryMax) no meio
 * da escrita — `moveFile` já usava `rename`, `writeFile`/`editFile` não. Ver
 * docs/proposta P2-escrita-arquivo-atomica.
 *
 * BUG FIX (auditoria de produção, achado durante validação do fix de
 * diretórios): o `tmp` é criado via `fs.writeFile` pelo processo do
 * sandbox-agent, que roda como root — então SEMPRE nasce root:root. O
 * `rename` não muda ownership, então o arquivo final também ficava
 * root:root. Isso não afetava só `fs_write` de arquivo NOVO: `fs_edit`
 * num arquivo já existente (ex.: um arquivo do repo, clonado como
 * sandbox:sandbox) também passava por aqui e TROCAVA o dono dele pra
 * root:root — quebrando qualquer `run_command`/`start_process` (uid 1001)
 * que precisasse reescrever esse arquivo depois (ex.: eslint --fix,
 * prettier, build tools). Fix: chown pra sandbox:sandbox logo após o
 * rename, sempre.
 */
async function atomicWrite(abs: string, buf: Buffer): Promise<void> {
  const tmp = `${abs}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, abs);
    try {
      await fs.chown(abs, SANDBOX_UID, SANDBOX_GID);
    } catch {
      // Non-fatal: ambientes sem privilégio (dev local) não conseguem
      // chown — o arquivo já foi escrito corretamente, só não fica com
      // o owner ideal. Não deve bloquear fs_write/fs_edit.
    }
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export type FsErrorCode =
  | 'ENOENT'
  | 'EISDIR'
  | 'ENOTDIR'
  | 'EEXIST'
  | 'EACCES'
  | 'EINVAL'
  | 'ECONFLICT'
  | 'ENOTFOUND';

export class FsError extends Error {
  constructor(message: string, public code: FsErrorCode) {
    super(message);
    this.name = 'FsError';
  }
}

export interface FileStat {
  path: string;
  type: 'file' | 'dir' | 'other';
  size: number;
  mtime: Date;
}

export interface FileEntry {
  name: string;
  type: 'file' | 'dir' | 'other';
  size?: number;
  mtime?: Date;
}

export interface TreeNode {
  name: string;
  type: 'file' | 'dir';
  size?: number;
  children?: TreeNode[];
}

export interface TreeOpts {
  depth?: number;
  maxEntries?: number;
  includeHidden?: boolean;
}

const DEFAULT_TREE_IGNORE = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  'coverage', '.turbo', '.vite', '.svelte-kit', '__pycache__', '.venv', 'venv',
]);

function safe(p: string): string {
  try {
    return resolveSafe(p);
  } catch {
    throw new FsError('path inválido ou fora do workspace', 'EINVAL');
  }
}

/** Versão exportada para uso em outros módulos */
export function safePath(p: string): string {
  return safe(p);
}

function wrapNodeFsError(e: unknown, fallback: string): never {
  const code = (e as NodeJS.ErrnoException)?.code;
  switch (code) {
    case 'ENOENT': throw new FsError('arquivo ou diretório não existe', 'ENOENT');
    case 'EISDIR': throw new FsError('é um diretório, esperava arquivo', 'EISDIR');
    case 'ENOTDIR': throw new FsError('não é um diretório', 'ENOTDIR');
    case 'EEXIST': throw new FsError('já existe', 'EEXIST');
    case 'EACCES': throw new FsError('sem permissão', 'EACCES');
    default: throw new FsError(fallback, 'EINVAL');
  }
}

export function computeETag(buf: Buffer, mtime: Date): string {
  const hash = createHash('sha1').update(buf).digest('hex').slice(0, 16);
  return `"${hash}-${mtime.getTime().toString(16)}"`;
}

export function computeMetaETag(size: number, mtimeMs: number): string {
  return `W/"${size.toString(16)}-${mtimeMs.toString(16)}"`;
}

export async function readFile(p: string): Promise<{ content: string; bytes: number; mtime: Date; etag: string }> {
  const abs = safe(p);
  try {
    const buf = await fs.readFile(abs);
    const st = await fs.stat(abs);
    return {
      content: buf.toString('utf8'),
      bytes: buf.length,
      mtime: st.mtime,
      etag: computeETag(buf, st.mtime),
    };
  } catch (e) { wrapNodeFsError(e, 'fs.readFile falhou'); }
}

export async function readFileBuffer(p: string): Promise<{ buffer: Buffer; bytes: number; mtime: Date; etag: string }> {
  const abs = safe(p);
  try {
    const buf = await fs.readFile(abs);
    const st = await fs.stat(abs);
    return { buffer: buf, bytes: buf.length, mtime: st.mtime, etag: computeETag(buf, st.mtime) };
  } catch (e) { wrapNodeFsError(e, 'fs.readFile falhou'); }
}

export async function writeFile(
  p: string,
  content: string | Buffer,
  opts: { ifMatchETag?: string } = {},
): Promise<{ etag: string; bytes: number; path: string }> {
  const abs = safe(p);
  if (opts.ifMatchETag) {
    try {
      const existing = await fs.readFile(abs);
      const st = await fs.stat(abs);
      const current = computeETag(existing, st.mtime);
      if (current !== opts.ifMatchETag) {
        throw new FsError('ETag não bate (concurrent modification)', 'ECONFLICT');
      }
    } catch (e) {
      if (e instanceof FsError) throw e;
      if (opts.ifMatchETag !== '*') throw new FsError('arquivo não existe pra If-Match', 'ENOENT');
    }
  }
  await mkdirChowned(path.dirname(abs));
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  await atomicWrite(abs, buf);
  const st = await fs.stat(abs);
  return { etag: computeETag(buf, st.mtime), bytes: buf.length, path: toRelative(abs) };
}

export async function editFile(p: string, oldText: string, newText: string): Promise<{ etag: string; path: string }> {
  const abs = safe(p);
  let current: Buffer;
  try { current = await fs.readFile(abs); }
  catch (e) { wrapNodeFsError(e, 'fs.readFile falhou'); }
  const text = current.toString('utf8');
  const first = text.indexOf(oldText);
  if (first === -1) throw new FsError('oldText não encontrado', 'ENOTFOUND');
  const second = text.indexOf(oldText, first + 1);
  if (second !== -1) throw new FsError('oldText aparece mais de uma vez (inclua mais contexto pra deixar único)', 'ECONFLICT');
  const updated = text.slice(0, first) + newText + text.slice(first + oldText.length);
  const buf = Buffer.from(updated, 'utf8');
  await atomicWrite(abs, buf);
  const st = await fs.stat(abs);
  return { etag: computeETag(buf, st.mtime), path: toRelative(abs) };
}

/**
 * P2: stat em cada entry era N+1 de filesystem — removido por padrão.
 * `withStats` opcional mantém comportamento legado pra quem precisa.
 */
export async function listDir(
  p: string,
  opts: { withStats?: boolean } = {},
): Promise<{ path: string; entries: FileEntry[] }> {
  const abs = safe(p);
  let dirents;
  try { dirents = await fs.readdir(abs, { withFileTypes: true }); }
  catch (e) { wrapNodeFsError(e, 'fs.readdir falhou'); }
  const entries: FileEntry[] = opts.withStats
    ? await Promise.all(dirents.map(async (e) => {
        const full = path.join(abs, e.name);
        const type = e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other';
        let size: number | undefined;
        let mtime: Date | undefined;
        try {
          const st = await fs.stat(full);
          if (type === 'file') size = st.size;
          mtime = st.mtime;
        } catch {}
        return { name: e.name, type, size, mtime };
      }))
    : dirents.map((e) => ({
        name: e.name,
        type: (e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other') as 'file' | 'dir' | 'other',
      }));
  return { path: toRelative(abs), entries };
}

export async function statPath(p: string): Promise<FileStat> {
  const abs = safe(p);
  try {
    const st = await fs.stat(abs);
    return {
      path: toRelative(abs),
      type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
      size: st.size,
      mtime: st.mtime,
    };
  } catch (e) { wrapNodeFsError(e, 'fs.stat falhou'); }
}

export async function mkdir(p: string): Promise<{ path: string }> {
  const abs = safe(p);
  await mkdirChowned(abs);
  return { path: toRelative(abs) };
}

export async function moveFile(from: string, to: string): Promise<{ from: string; to: string }> {
  const absFrom = safe(from);
  const absTo = safe(to);
  await mkdirChowned(path.dirname(absTo));
  try { await fs.rename(absFrom, absTo); }
  catch (e) { wrapNodeFsError(e, 'fs.rename falhou'); }
  return { from: toRelative(absFrom), to: toRelative(absTo) };
}

export async function deletePath(p: string, recursive: boolean): Promise<{ path: string }> {
  const abs = safe(p);
  if (abs === getWorktreePath()) throw new FsError('não permito remover a raiz do worktree', 'EINVAL');
  try { await fs.rm(abs, { recursive, force: false }); }
  catch (e) { wrapNodeFsError(e, 'fs.rm falhou'); }
  return { path: toRelative(abs) };
}

export async function tree(p: string, opts: TreeOpts = {}): Promise<{ root: string; totalEntries: number; truncated: boolean; tree: TreeNode[] }> {
  const abs = safe(p);
  const maxDepth = opts.depth ?? 3;
  const maxEntries = opts.maxEntries ?? 500;
  const hidden = opts.includeHidden ?? false;
  let counted = 0;
  let truncated = false;

  const skip = (name: string): boolean =>
    DEFAULT_TREE_IGNORE.has(name) || (!hidden && name.startsWith('.') && name !== '.');

  async function walk(dir: string, depth: number): Promise<TreeNode[]> {
    if (truncated || depth > maxDepth) return [];
    let dirents;
    try { dirents = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return []; }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    const out: TreeNode[] = [];
    for (const e of dirents) {
      if (skip(e.name)) continue;
      if (counted >= maxEntries) { truncated = true; break; }
      counted++;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.push({ name: e.name, type: 'dir', children: await walk(full, depth + 1) });
      } else if (e.isFile()) {
        // T2: size removido do tree node — economiza tokens no JSON de resposta
        out.push({ name: e.name, type: 'file' });
      }
    }
    return out;
  }

  const result = await walk(abs, 1);
  return { root: toRelative(abs), totalEntries: counted, truncated, tree: result };
}

/**
 * P4: Em vez de ler o arquivo inteiro na memória, usa createReadStream
 * com contador de linhas para arquivos grandes. Limite de 5MB para
 * fallback em memória; acima disso, faz stream linha-por-linha.
 */
export async function readRange(p: string, fromLine: number, toLine: number): Promise<{ path: string; fromLine: number; toLine: number; totalLines: number; truncated: boolean; content: string }> {
  if (toLine < fromLine) throw new FsError('toLine < fromLine', 'EINVAL');
  if (toLine - fromLine + 1 > 1000) throw new FsError('intervalo > 1000 linhas', 'EINVAL');
  const abs = safe(p);

  // Verifica tamanho do arquivo pra decidir estratégia
  let st: Stats;
  try { st = await fs.stat(abs); }
  catch (e) { wrapNodeFsError(e, 'fs.stat falhou'); }

  const STREAM_THRESHOLD = 2 * 1024 * 1024; // 2MB

  if (st.size < STREAM_THRESHOLD) {
    // Arquivo pequeno — ler direto é mais rápido
    let raw: string;
    try { raw = await fs.readFile(abs, 'utf8'); }
    catch (e) { wrapNodeFsError(e, 'fs.readFile falhou'); }
    const lines = raw.split('\n');
    const total = lines.length;
    const slice = lines.slice(fromLine - 1, toLine);
    return {
      path: toRelative(abs),
      fromLine,
      toLine: Math.min(toLine, total),
      totalLines: total,
      truncated: toLine > total,
      content: slice.join('\n'),
    };
  }

  // Arquivo grande — stream linha-por-linha
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: createReadStream(abs, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    const collected: string[] = [];
    let currentLine = 0;
    let totalLines = 0;

    rl.on('line', (line: string) => {
      currentLine++;
      totalLines = currentLine;
      if (currentLine >= fromLine && currentLine <= toLine) {
        collected.push(line);
      }
      if (currentLine > toLine) {
        rl.close();
      }
    });

    rl.on('close', () => {
      resolve({
        path: toRelative(abs),
        fromLine,
        toLine: Math.min(toLine, totalLines),
        totalLines: totalLines,
        truncated: toLine > totalLines,
        content: collected.join('\n'),
      });
    });

    rl.on('error', (e: unknown) => {
      reject(new FsError(
        e instanceof Error ? e.message : 'fs.readRange stream falhou',
        'EINVAL',
      ));
    });
  });
}
