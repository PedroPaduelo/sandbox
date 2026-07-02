import type { FastifyReply } from 'fastify';
import { FsError } from '@/fs/service.js';

export const FS_STATUS_MAP: Record<string, number> = {
  ENOENT: 404,
  EEXIST: 409,
  EACCES: 403,
  EINVAL: 400,
  EISDIR: 400,
  ENOTDIR: 400,
  ECONFLICT: 409,
  ENOTFOUND: 404,
} as const;

export function mapFsError(e: unknown, reply: FastifyReply): void {
  if (e instanceof FsError) {
    const status = FS_STATUS_MAP[e.code] ?? 500;
    reply.code(status).send({ error: e.message, code: e.code });
    return;
  }
  throw e;
}

/**
 * Função utilitária para converter código de erro filesystem para status HTTP
 * @param code - O código de erro
 * @returns O status HTTP correspondente
 */
export function fsErrorToStatus(code: string): number {
  return FS_STATUS_MAP[code] ?? 500;
}