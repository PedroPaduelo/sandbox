import type { FastifyRequest } from "fastify";
import { env } from "../lib/env.js";

export function extractBearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  return /^Bearer\s+(.+)$/i.exec(header.trim())?.[1];
}

export function extractTokenWithFallback(req: FastifyRequest): string | undefined {
  return extractBearerToken(req) ?? (req.query as Record<string, string>)?.token;
}

export function validateToken(token: string | undefined): boolean {
  return token === env.SANDBOX_TOKEN;
}
