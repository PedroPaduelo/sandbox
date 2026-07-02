import { Type } from '@sinclair/typebox';

/**
 * Schemas REST das tools de processo. Espelham as interfaces exportadas em
 * `src/tools/processes.ts` (ManagedProcessSummary, ProcessOutputPayload, etc.).
 *
 * Servem 2 audiências:
 *  - Frontend (painel "Processes" no IDE) — consome via gateway.
 *  - Operadores via OpenAPI docs (/api/v1/docs).
 */

const ProcessStatus = Type.Union(
  [
    Type.Literal('running'),
    Type.Literal('completed'),
    Type.Literal('failed'),
    Type.Literal('killed'),
  ],
  { description: 'Estado do processo gerenciado' },
);

export const ManagedProcessSummary = Type.Object({
  processId: Type.String(),
  label: Type.Optional(Type.String()),
  port: Type.Optional(Type.Integer()),
  pid: Type.Optional(Type.Integer()),
  cmd: Type.String(),
  cwd: Type.String(),
  status: ProcessStatus,
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  elapsedMs: Type.Integer(),
  stdoutBytes: Type.Integer(),
  stderrBytes: Type.Integer(),
});

export const ListProcessesRes = Type.Object({
  processes: Type.Array(ManagedProcessSummary),
});

export const KillProcessParams = Type.Object({
  id: Type.String(),
});

export const KillProcessRes = Type.Object({
  processId: Type.String(),
  status: ProcessStatus,
  scopeStopped: Type.Optional(Type.Boolean()),
  note: Type.Optional(Type.String()),
});

export const RestartProcessReq = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 128 }),
  cmd: Type.String({ minLength: 1, maxLength: 4096 }),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  cwd: Type.Optional(Type.String({ maxLength: 4096 })),
});

// Response do restart é o payload "cru" do spawnManaged. Tipamos genérico aqui
// pra evitar acoplar — Fastify aceita Type.Object({}) com additionalProperties.
export const RestartProcessRes = Type.Object(
  {
    processId: Type.String(),
    label: Type.Optional(Type.String()),
    port: Type.Optional(Type.Integer()),
    sandboxed: Type.Boolean(),
    isolated: Type.Boolean(),
    scopeName: Type.Optional(Type.String()),
    pid: Type.Optional(Type.Integer()),
    status: ProcessStatus,
    cmd: Type.String(),
    cwd: Type.String(),
    stdoutPreview: Type.String(),
    stderrPreview: Type.String(),
  },
  { additionalProperties: true },
);

export const LogsParams = Type.Object({
  id: Type.String(),
});

export const LogsQuery = Type.Object({
  tailLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
});

export const LogsRes = Type.Object({
  processId: Type.String(),
  status: ProcessStatus,
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  elapsedMs: Type.Integer(),
  stdout: Type.String(),
  stderr: Type.String(),
  stdoutBytes: Type.Integer(),
  stderrBytes: Type.Integer(),
});
