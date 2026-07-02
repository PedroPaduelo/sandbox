import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyError } from 'fastify';
import { FsError } from '@/fs/service.js';
import { FS_STATUS_MAP } from '@/http/routes/fs/error-map.js';
import { BadRequestError, UnauthorizedError, NotFoundError } from '@/http/routes/_errors/index.js';

/**
 * Função para converter código de erro filesystem para status HTTP
 * @param code - O código de erro
 * @returns O status HTTP correspondente
 */
export function fsErrorToStatus(code: string): number {
  return FS_STATUS_MAP[code] ?? 500;
}

/**
 * Error handler global para o Fastify
 * Trata FsError, BadRequestError, UnauthorizedError, NotFoundError e erros genéricos
 */
export function errorHandler(
  error: FastifyError,
  _request: FastifyRequest,
  reply: FastifyReply
): void {
  let statusCode: number;
  let message: string;

  // Tratar erros customizados
  if (error instanceof FsError) {
    statusCode = fsErrorToStatus(error.code);
    message = error.message;
  } else if (error instanceof BadRequestError) {
    statusCode = 400;
    message = error.message;
  } else if (error instanceof UnauthorizedError) {
    statusCode = 401;
    message = error.message;
  } else if (error instanceof NotFoundError) {
    statusCode = 404;
    message = error.message;
  } else {
    // Erro genérico
    statusCode = error.statusCode ?? 500;
    message = error.message || 'Internal Server Error';
  }

  reply.code(statusCode).send({
    error: message,
    statusCode,
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack }),
  });
}