declare module "fastify" {
  interface FastifyRequest {
    // sandbox-agent não populates ctx — sem JWT. Mantemos para compatibilidade de tipo.
  }
}

export {};
