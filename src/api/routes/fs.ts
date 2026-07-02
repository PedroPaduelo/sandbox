import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import { createReadStream } from 'node:fs';
import * as fsNode from 'node:fs/promises';
import * as fsSvc from '../../fs/service.js';
import { FsError } from '../../fs/service.js';
import { searchFiles } from '../../fs/search.js';
import { detectMime } from '../../fs/mime.js';
import { resolveSafe } from '../../workspace.js';
import { computeMetaETag } from '../../fs/service.js';
import { watchPaths } from '../../fs/watcher.js';
import { register as registerWatcher, unregister as unregisterWatcher } from '../../fs/watcher-registry.js';
import { mapFsError } from '../../http/routes/fs/error-map.js';
import {
  ListReq, ListRes,
  FileReadReq, FileWriteJsonReq, FileWriteRes,
  FileEditReq, FileEditRes,
  FileDeleteReq, MkdirReq, MkdirRes,
  MoveReq, MoveRes, StatReq, StatRes,
  TreeReq, TreeRes,
  SearchReq, SearchRes,
  RangeReq, RangeRes,
  WatchReq,
} from '../schemas/fs.js';
import { ErrorResponse } from '../schemas/common.js';
import { FileWriteRawReq } from '../schemas/fs.js';

const STREAM_THRESHOLD = 1 * 1024 * 1024; // 1MB

const fsRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // ── GET /fs/list ────────────────────────────────────────────────────
  app.get('/fs/list', {
    schema: {
      querystring: ListReq,
      response: { 200: ListRes, 404: ErrorResponse },
    },
  }, async (req, reply) => {
    try {
      const r = await fsSvc.listDir(req.query.path ?? '.');
      return {
        path: r.path,
        entries: r.entries.map((e) => ({
          name: e.name,
          type: e.type,
        })),
      };
    } catch (e) {
      mapFsError(e, reply);
    }
  });

  // ── GET /fs/file ────────────────────────────────────────────────────
  app.get('/fs/file', {
    schema: {
      querystring: FileReadReq,
    },
  }, async (req, reply) => {
    let abs: string;
    try {
      abs = resolveSafe(req.query.path);
    } catch {
      reply.code(400).send({ error: 'path inválido', code: 'EINVAL' }); return;
    }

    let st: Awaited<ReturnType<typeof fsNode.stat>>;
    try {
      st = await fsNode.stat(abs);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') { reply.code(404).send({ error: 'arquivo não existe', code: 'ENOENT' }); return; }
      throw e;
    }
    if (!st.isFile()) { reply.code(400).send({ error: 'não é arquivo', code: 'EISDIR' }); return; }

    // ETag: hash pra pequenos, meta pra grandes
    let etag: string;
    if (st.size < STREAM_THRESHOLD) {
      const buf = await fsNode.readFile(abs);
      etag = fsSvc.computeETag(buf, st.mtime);
      if (req.headers['if-none-match'] === etag) { reply.code(304).send(); return; }
      reply
        .header('etag', etag)
        .header('last-modified', st.mtime.toUTCString())
        .header('content-type', detectMime(req.query.path))
        .header('accept-ranges', 'bytes');

      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d+)-(\d*)$/i.exec(range);
        if (m) {
          const start = parseInt(m[1], 10);
          const end = m[2] ? Math.min(parseInt(m[2], 10), st.size - 1) : st.size - 1;
          if (start > end || start >= st.size) {
            reply.header('content-range', `bytes */${st.size}`);
            reply.code(416).send(); return;
          }
          const slice = buf.subarray(start, end + 1);
          reply
            .code(206)
            .header('content-range', `bytes ${start}-${end}/${st.size}`)
            .header('content-length', String(slice.length));
          reply.send(slice); return;
        }
      }
      reply.header('content-length', String(st.size));
      reply.send(buf); return;
    }

    // Grande: streaming
    etag = computeMetaETag(st.size, st.mtimeMs);
    if (req.headers['if-none-match'] === etag) { reply.code(304).send(); return; }
    reply
      .header('etag', etag)
      .header('last-modified', st.mtime.toUTCString())
      .header('content-type', detectMime(req.query.path))
      .header('accept-ranges', 'bytes');

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/i.exec(range);
      if (m) {
        const start = parseInt(m[1], 10);
        const end = m[2] ? Math.min(parseInt(m[2], 10), st.size - 1) : st.size - 1;
        if (start > end || start >= st.size) {
          reply.header('content-range', `bytes */${st.size}`);
          reply.code(416).send(); return;
        }
        reply
          .code(206)
          .header('content-range', `bytes ${start}-${end}/${st.size}`)
          .header('content-length', String(end - start + 1));
        reply.send(createReadStream(abs, { start, end })); return;
      }
    }
    reply.header('content-length', String(st.size));
    reply.send(createReadStream(abs)); return;
  });

  // ── PUT /fs/file (JSON) ─────────────────────────────────────────────
  app.put('/fs/file', {
    schema: {
      body: FileWriteJsonReq,
      response: {
        200: FileWriteRes,
        412: ErrorResponse,
        413: ErrorResponse,
      },
    },
    bodyLimit: 350 * 1024 * 1024,
  }, async (req, reply) => {
    try {
      const ifMatch = req.headers['if-match'];
      const r = await fsSvc.writeFile(req.body.path, req.body.content, {
        ifMatchETag: typeof ifMatch === 'string' ? ifMatch : undefined,
      });
      reply.header('etag', r.etag);
      return { ok: true as const, path: r.path, bytes: r.bytes, etag: r.etag };
    } catch (e) {
      if (e instanceof FsError && e.code === 'ECONFLICT') {
        reply.code(412).send({ error: e.message, code: 'ETAG_MISMATCH' }); return;
      }
      mapFsError(e, reply);
    }
  });

  // ── PATCH /fs/file ──────────────────────────────────────────────────
  app.patch('/fs/file', {
    schema: {
      body: FileEditReq,
      response: {
        200: FileEditRes,
        404: ErrorResponse,
        422: ErrorResponse,
      },
    },
    bodyLimit: 350 * 1024 * 1024,
  }, async (req, reply) => {
    try {
      const r = await fsSvc.editFile(req.body.path, req.body.oldText, req.body.newText);
      reply.header('etag', r.etag);
      return { ok: true as const, path: r.path, etag: r.etag };
    } catch (e) {
      if (e instanceof FsError && e.code === 'ENOTFOUND') {
        reply.code(422).send({ error: e.message, code: 'OLDTEXT_NOT_FOUND' }); return;
      }
      if (e instanceof FsError && e.code === 'ECONFLICT') {
        reply.code(422).send({ error: e.message, code: 'OLDTEXT_AMBIGUOUS' }); return;
      }
      mapFsError(e, reply);
    }
  });

  // ── DELETE /fs/file ─────────────────────────────────────────────────
  app.delete('/fs/file', {
    schema: {
      querystring: FileDeleteReq,
      response: {
        204: Type.Object({}),
        404: ErrorResponse,
        409: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    try {
      await fsSvc.deletePath(req.query.path, req.query.recursive ?? false);
      reply.code(204).send({}); return;
    } catch (e) {
      mapFsError(e, reply);
    }
  });

  // ── POST /fs/mkdir ──────────────────────────────────────────────────
  app.post('/fs/mkdir', {
    schema: { body: MkdirReq, response: { 201: MkdirRes } },
  }, async (req, reply) => {
    const r = await fsSvc.mkdir(req.body.path);
    reply.code(201).send({ ok: true as const, path: r.path });
  });

  // ── POST /fs/move ───────────────────────────────────────────────────
  app.post('/fs/move', {
    schema: {
      body: MoveReq,
      response: {
        200: MoveRes,
        404: ErrorResponse,
        409: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    try {
      const r = await fsSvc.moveFile(req.body.from, req.body.to);
      return { ok: true as const, from: r.from, to: r.to };
    } catch (e) {
      mapFsError(e, reply);
    }
  });

  // ── GET /fs/stat ────────────────────────────────────────────────────
  app.get('/fs/stat', {
    schema: {
      querystring: StatReq,
      response: {
        200: StatRes,
        404: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    try {
      const r = await fsSvc.statPath(req.query.path);
      return {
        path: r.path,
        type: r.type,
        size: r.size,
        mtime: r.mtime.toISOString(),
      };
    } catch (e) {
      mapFsError(e, reply);
    }
  });

  // ── GET /fs/tree ──────────────────────────────────────────────────────
  app.get('/fs/tree', {
    schema: {
      querystring: TreeReq,
      response: {
        200: TreeRes,
        404: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    try {
      const r = await fsSvc.tree(req.query.path ?? '.', {
        depth: req.query.depth ?? 1,
        maxEntries: req.query.maxEntries ?? 500,
        includeHidden: req.query.hidden ?? false,
      });
      return r;
    } catch (e) {
      mapFsError(e, reply);
    }
  });

  // ── POST /fs/search ──────────────────────────────────────────────────
  app.post('/fs/search', {
    schema: { body: SearchReq, response: { 200: SearchRes, 400: ErrorResponse } },
  }, async (req, reply) => {
    try {
      const r = await searchFiles(req.body.pattern, {
        onlyNames: req.body.onlyNames,
        path: req.body.path,
        caseInsensitive: req.body.caseInsensitive,
        maxResults: req.body.maxResults,
      });
      return r;
    } catch (e) {
      mapFsError(e, reply);
    }
  });

  // ── GET /fs/file/range ──────────────────────────────────────────────
  app.get('/fs/file/range', {
    schema: {
      querystring: RangeReq,
      response: {
        200: RangeRes,
        400: ErrorResponse,
        404: ErrorResponse,
      },
    },
  }, async (req, reply) => {
    try {
      const r = await fsSvc.readRange(req.query.path, req.query.from, req.query.to);
      return r;
    } catch (e) {
      mapFsError(e, reply);
    }
  });

  // ── PUT /fs/file/raw (body binário) — sub-plugin com parser isolado ──
  await app.register(async (rawApp) => {
    const rawTyped = rawApp.withTypeProvider<TypeBoxTypeProvider>();
    rawTyped.addContentTypeParser(/.*/, { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    rawTyped.put('/fs/file/raw', {
      schema: {
        querystring: FileWriteRawReq,
        response: { 200: FileWriteRes, 412: ErrorResponse },
      },
      bodyLimit: 350 * 1024 * 1024,
    }, async (req, reply) => {
      const writePath = req.query.path;
      const content = req.body as Buffer;

      try {
        const ifMatch = req.headers['if-match'];
        const r = await fsSvc.writeFile(writePath, content, {
          ifMatchETag: typeof ifMatch === 'string' ? ifMatch : undefined,
        });
        reply.header('etag', r.etag);
        return { ok: true as const, path: r.path, bytes: r.bytes, etag: r.etag };
      } catch (e) {
        if (e instanceof FsError && e.code === 'ECONFLICT') {
          reply.code(412).send({ error: e.message, code: 'ETAG_MISMATCH' }); return;
        }
        mapFsError(e, reply);
      }
    });
  });

  // ── WS /fs/watch ────────────────────────────────────────────────────
  let activeWatchers = 0;
  const MAX_WATCHERS = parseInt(process.env.MAX_WATCHERS ?? '10', 10);

  app.get('/fs/watch', {
    websocket: true,
    schema: { querystring: WatchReq },
  }, (socket, req) => {
    if (activeWatchers >= MAX_WATCHERS) {
      socket.close(1013, 'muitos watchers ativos');
      return;
    }
    activeWatchers++;

    const q = req.query as { paths?: string; events?: string };
    const initialPaths = (q.paths ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const allowed = new Set(((q.events ?? 'created,modified,deleted')).split(',').map((s) => s.trim()));

    let sub: ReturnType<typeof watchPaths>;
    try {
      sub = watchPaths(initialPaths, (e) => {
        if (!allowed.has(e.type)) return;
        if (socket.readyState !== socket.OPEN) return;
        // backpressure
        const buffered = (socket as unknown as { bufferedAmount?: number }).bufferedAmount;
        if (typeof buffered === 'number' && buffered > 1_000_000) return;
        socket.send(JSON.stringify(e));
      });
    } catch (err) {
      socket.close(1011, 'erro ao iniciar watcher');
      activeWatchers--;
      return;
    }

    const hb = setInterval(() => {
      if (socket.readyState !== socket.OPEN) return;
      try { socket.ping(); } catch {}
    }, 15_000);

    socket.on('message', (raw: Buffer) => {
      let msg: unknown;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if ((msg as { op?: string })?.op === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if ((msg as { op?: string; paths?: string[] })?.op === 'subscribe' && Array.isArray((msg as { paths?: string[] }).paths)) {
        try { sub.add((msg as { paths: string[] }).paths); } catch (err) {
          socket.send(JSON.stringify({ type: 'error', error: (err as Error).message }));
        }
      }
      if ((msg as { op?: string; paths?: string[] })?.op === 'unsubscribe' && Array.isArray((msg as { paths?: string[] }).paths)) {
        try { sub.remove((msg as { paths?: string[] }).paths ?? []); } catch {}
      }
    });

    // Registrar no registry para shutdown limpo
    const entry = { unsubscribe: () => sub.unsubscribe(), socket };
    registerWatcher(entry);

    const cleanup = (): void => {
      clearInterval(hb);
      sub.unsubscribe();
      activeWatchers--;
      unregisterWatcher(entry);
    };
    socket.on('close', cleanup);
    socket.on('error', () => cleanup());
  });
};

export default fsRoutes;