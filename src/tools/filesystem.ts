import { z } from 'zod';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fsSvc from '../fs/service.js';
import { searchFiles } from '../fs/search.js';
import { FsError } from '../fs/service.js';

const okText = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const okJson = (obj: unknown) => okText(JSON.stringify(obj));
const err = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true });

export function registerFilesystemTools(server: McpServer): void {
  server.registerTool(
    'fs_read',
    {
      description: 'Lê um arquivo do workspace. Retorna o conteúdo como texto UTF-8.',
      inputSchema: {
        path: z.string().describe('Path relativo ao workspace (ex.: "src/index.ts")'),
      },
    },
    async ({ path: p }) => {
      try {
        const { content, bytes } = await fsSvc.readFile(p);
        // T1: Cap automático de 256KB pra evitar queimar contexto da IA
        const READ_CAP = 256 * 1024;
        if (bytes > READ_CAP) {
          const truncated = content.slice(0, READ_CAP);
          return okText(truncated + `\n\n…[truncated — ${bytes} bytes total, mostrando primeiros ${READ_CAP}. Use fs_read_range pra ver o resto]`);
        }
        return okText(content);
      } catch (e) {
        if (e instanceof FsError) return err(`fs_read falhou (${p}): ${e.message}`);
        return err(`fs_read falhou (${p}): ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'fs_write',
    {
      description: 'Escreve (ou sobrescreve) um arquivo. Cria diretórios pai automaticamente.',
      inputSchema: {
        path: z.string().describe('Path relativo ao workspace'),
        content: z.string().describe('Conteúdo completo do arquivo'),
      },
    },
    async ({ path: p, content }) => {
      try {
        const r = await fsSvc.writeFile(p, content);
        return okJson({ ok: true, path: r.path, bytes: r.bytes });
      } catch (e) {
        if (e instanceof FsError) return err(`fs_write falhou (${p}): ${e.message}`);
        return err(`fs_write falhou (${p}): ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'fs_edit',
    {
      description: 'Substitui exatamente um trecho em um arquivo existente. Falha se oldText não for encontrado ou aparecer mais de uma vez (use trechos únicos com contexto).',
      inputSchema: {
        path: z.string(),
        oldText: z.string().describe('Trecho exato a substituir (deve ser único no arquivo)'),
        newText: z.string().describe('Novo trecho'),
      },
    },
    async ({ path: p, oldText, newText }) => {
      try {
        const r = await fsSvc.editFile(p, oldText, newText);
        return okJson({ ok: true, path: r.path });
      } catch (e) {
        if (e instanceof FsError) return err(`fs_edit falhou (${p}): ${e.message}`);
        return err(`fs_edit falhou (${p}): ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'fs_list',
    {
      description: 'Lista o conteúdo de um diretório (não recursivo).',
      inputSchema: {
        path: z.string().default('.').describe('Path relativo (default: raiz do workspace)'),
      },
    },
    async ({ path: p }) => {
      try {
        const { path: dirPath, entries } = await fsSvc.listDir(p);
        const json = { path: dirPath, entries };
        return okJson(json);
      } catch (e) {
        if (e instanceof FsError) return err(`fs_list falhou: ${e.message}`);
        return err(`fs_list falhou: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'fs_mkdir',
    {
      description: 'Cria um diretório (recursivo).',
      inputSchema: {
        path: z.string().describe('Path relativo ao workspace'),
      },
    },
    async ({ path: p }) => {
      try {
        const r = await fsSvc.mkdir(p);
        return okJson({ ok: true, path: r.path });
      } catch (e) {
        if (e instanceof FsError) return err(`fs_mkdir falhou: ${e.message}`);
        return err(`fs_mkdir falhou: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'fs_stat',
    {
      description: 'Obtém metadados de um arquivo ou diretório.',
      inputSchema: {
        path: z.string().describe('Path relativo ao workspace'),
      },
    },
    async ({ path: p }) => {
      try {
        const stat = await fsSvc.statPath(p);
        return okJson(stat);
      } catch (e) {
        if (e instanceof FsError) return err(`fs_stat falhou: ${e.message}`);
        return err(`fs_stat falhou: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'fs_move',
    {
      description: 'Move/renomeia arquivo ou diretório.',
      inputSchema: {
        from: z.string().describe('Path de origem'),
        to: z.string().describe('Path de destino'),
      },
    },
    async ({ from, to }) => {
      try {
        const r = await fsSvc.moveFile(from, to);
        return okJson({ ok: true, from: r.from, to: r.to });
      } catch (e) {
        if (e instanceof FsError) return err(`fs_move falhou: ${e.message}`);
        return err(`fs_move falhou: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'fs_delete',
    {
      description:
        'Remove arquivo ou diretório (recursivo se for diretório). ' +
        'IMPORTANTE: se você for checar o resultado logo depois (ex.: fs_stat/fs_read/fs_list ' +
        'no mesmo path), espere a resposta deste fs_delete chegar antes de disparar a próxima ' +
        'chamada — não as dispare em paralelo/no mesmo batch. Chamadas concorrentes numa mesma ' +
        'path com dependência causal (delete → leitura) podem correr na frente do delete e ' +
        'retornar metadado obsoleto.',
      inputSchema: {
        path: z.string().describe('Path relativo ao workspace'),
        recursive: z.boolean().default(false).describe('Remover recursivamente (default: false)'),
      },
    },
    async ({ path: p, recursive }) => {
      try {
        const r = await fsSvc.deletePath(p, recursive);
        return okJson({ ok: true, path: r.path });
      } catch (e) {
        if (e instanceof FsError) return err(`fs_delete falhou: ${e.message}`);
        return err(`fs_delete falhou: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'fs_search',
    {
      description: 'Busca por padrão em arquivos (usa ripgrep se disponível, senão grep/find). Timeout de 30s por padrão; em diretórios grandes, restrinja `path` ou use `onlyNames`.',
      inputSchema: {
        pattern: z.string().describe('Padrão a buscar'),
        onlyNames: z.boolean().default(false).describe('Buscar apenas nomes de arquivos'),
        path: z.string().optional().describe('Path base para busca (relativo ao workspace)'),
        caseInsensitive: z.boolean().default(false).describe('Busca case-insensitive'),
        maxResults: z.number().default(200).describe('Máximo de resultados'),
        timeoutMs: z.number().optional().describe('Timeout em ms (default 30000)'),
      },
    },
    async ({ pattern, onlyNames, path, caseInsensitive, maxResults, timeoutMs }) => {
      try {
        const r = await searchFiles(pattern, { onlyNames, path, caseInsensitive, maxResults, timeoutMs });
        if (r.timedOut) {
          return err(
            `fs_search timeout (${timeoutMs ?? 30000}ms, pattern="${pattern}", path="${path ?? '.'}"). Tente restringir o path, usar onlyNames=true, ou diminuir a árvore. Sem resultados retornados.`,
          );
        }
        return okJson({ matches: r.matches, truncated: r.truncated, tool: r.tool });
      } catch (e) {
        return err(`fs_search falhou (pattern="${pattern}", path="${path ?? '.'}"): ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'fs_read_range',
    {
      description: 'Lê um intervalo de linhas de um arquivo (útil para logs grandes).',
      inputSchema: {
        path: z.string().describe('Path relativo ao workspace'),
        from: z.number().describe('Linha inicial (1-based)'),
        to: z.number().describe('Linha final (1-based)'),
      },
    },
    async ({ path: p, from, to }) => {
      try {
        const r = await fsSvc.readRange(p, from, to);
        return okJson({
          path: r.path,
          fromLine: r.fromLine,
          toLine: r.toLine,
          totalLines: r.totalLines,
          truncated: r.truncated,
          content: r.content,
        });
      } catch (e) {
        if (e instanceof FsError) return err(`fs_read_range falhou: ${e.message}`);
        return err(`fs_read_range falhou: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'fs_tree',
    {
      description: 'Lista árvore de diretórios (recursivo, limitado por depth e maxEntries).',
      inputSchema: {
        path: z.string().optional().describe('Path relativo (default: raiz)'),
        maxDepth: z.number().optional().describe('Profundidade máxima (default: 3)'),
        maxEntries: z.number().optional().describe('Máximo de entradas (default: 500)'),
        includeHidden: z.boolean().default(false).describe('Incluir arquivos/dirs ocultos'),
      },
    },
    async ({ path, maxDepth, maxEntries, includeHidden }) => {
      try {
        const r = await fsSvc.tree(path ?? '.', { depth: maxDepth, maxEntries, includeHidden });
        return okJson({
          root: r.root,
          maxDepth: maxDepth ?? 3,
          maxEntries: maxEntries ?? 500,
          totalEntries: r.totalEntries,
          truncated: r.truncated,
          tree: r.tree,
        });
      } catch (e) {
        if (e instanceof FsError) return err(`fs_tree falhou: ${e.message}`);
        return err(`fs_tree falhou: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'fs_read_many',
    {
      description: 'Lê múltiplos arquivos de uma vez. Cap total de 512KB, cap individual de 256KB.',
      inputSchema: {
        paths: z.array(z.string()).min(1).max(50).describe('Lista de paths relativos (máx 50)'),
      },
    },
    async ({ paths }) => {
      const TOTAL_CAP = 512 * 1024;
      const FILE_CAP = 256 * 1024;
      let totalBytes = 0;
      const files = await Promise.all(paths.map(async (p) => {
        try {
          const { buffer, bytes } = await fsSvc.readFileBuffer(p);
          if (totalBytes >= TOTAL_CAP) return { path: p, bytes, truncated: true, content: '', error: 'total cap reached' };
          const cap = Math.min(FILE_CAP, TOTAL_CAP - totalBytes);
          const slice = buffer.subarray(0, cap);
          totalBytes += slice.length;
          return { path: p, bytes, truncated: bytes > cap, content: slice.toString('utf8') };
        } catch (e) {
          return { path: p, bytes: 0, truncated: false, content: '', error: (e as Error).message };
        }
      }));
      return okJson({ files, totalBytes, hitCap: totalBytes >= TOTAL_CAP });
    },
  );

  server.registerTool(
    'fs_write_many',
    {
      description: 'Escreve N arquivos em uma chamada. Cada arquivo tem seu próprio ok/erro.',
      inputSchema: {
        files: z.array(z.object({ path: z.string(), content: z.string() })).min(1).max(100),
      },
    },
    async ({ files }) => {
      const results = await Promise.all(files.map(async (f) => {
        try {
          const r = await fsSvc.writeFile(f.path, f.content);
          return { path: f.path, ok: true, bytes: r.bytes };
        } catch (e) {
          return { path: f.path, ok: false, bytes: 0, error: (e as Error).message };
        }
      }));
      const okCount = results.filter((r) => (r as { ok?: boolean }).ok).length;
      return okJson({ results, written: okCount, failed: results.length - okCount });
    },
  );

  server.registerTool(
    'project_overview',
    {
      description: 'Visão geral do projeto: keyFiles, stacks detectadas, contagem por extensão, tree estruturada.',
      inputSchema: z.object({}).shape,
    },
    async () => {
      // T3: Não carregar conteúdo de keyFiles — apenas detectar quais existem
      // e devolver stacks + tree + contagem por extensão. Economiza 3-8K tokens.
      const KEY_FILES: Record<string, string> = {
        'package.json': 'Node.js',
        'package-lock.json': 'Node.js',
        'yarn.lock': 'Node.js',
        'pnpm-lock.yaml': 'Node.js',
        'bun.lockb': 'Node.js (Bun)',
        'requirements.txt': 'Python',
        'pyproject.toml': 'Python',
        'Pipfile': 'Python',
        'go.mod': 'Go',
        'Cargo.toml': 'Rust',
        'composer.json': 'PHP',
        'Gemfile': 'Ruby',
        'pom.xml': 'Java',
        'build.gradle': 'Java (Gradle)',
        'go.sum': 'Go',
        'tsconfig.json': 'TypeScript',
        'next.config.js': 'Next.js',
        'tailwind.config.js': 'Tailwind',
        'AGENTS.md': 'Agent Config',
        'README.md': 'Docs',
      };

      const keyFileResults = await Promise.allSettled(
        Object.entries(KEY_FILES).map(async ([file, _type]) => {
          try {
            await fsSvc.statPath(file);
            return file;
          } catch {
            return null;
          }
        }),
      );

      const keyFiles = keyFileResults
        .filter((r): r is PromiseFulfilledResult<string | null> => r.status === 'fulfilled' && r.value !== null)
        .map((r) => r.value!);

      const stacks: string[] = [];
      for (const kf of keyFiles) {
        const type = KEY_FILES[kf];
        if (!stacks.includes(type)) stacks.push(type);
      }

      // Count files by extension
      const filesByExt: Record<string, number> = {};
      let totalFiles = 0;
      const visitedDirs = new Set<string>();

      async function countWalk(dir: string, depth: number): Promise<void> {
        if (depth > 3) return;
        try {
          const entries = await fsSvc.listDir(dir);
          for (const e of entries.entries) {
            if (e.type !== 'file') continue;
            totalFiles++;
            const ext = path.extname(e.name).toLowerCase() || '(no-ext)';
            filesByExt[ext] = (filesByExt[ext] ?? 0) + 1;
          }
          for (const e of entries.entries) {
            if (e.type === 'dir') {
              const fullPath = dir === '.' ? e.name : path.join(dir, e.name);
              if (!visitedDirs.has(fullPath)) {
                visitedDirs.add(fullPath);
                await countWalk(fullPath, depth + 1);
              }
            }
          }
        } catch {}
      }

      try {
        await countWalk('.', 1);
      } catch {}

      // Tree (depth 3, cap 200)
      const tree = await fsSvc.tree('.', { depth: 3, maxEntries: 200 });
      const sortedExts = Object.entries(filesByExt)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {} as Record<string, number>);

      return okJson({
        root: tree.root,
        keyFiles,
        stacks,
        totalFiles,
        filesByExt: sortedExts,
        tree: tree.tree,
        treeTruncated: tree.truncated,
      });
    },
  );
}
