import { Type, Static } from '@sinclair/typebox';

export const StackInfo = Type.Object({
  available: Type.Boolean(),
  version: Type.Optional(Type.String()),
});

export const WorkspaceRes = Type.Object({
  root: Type.String(),
  name: Type.String(),
  hostname: Type.String(),
  uptime: Type.Integer(),
  stacks: Type.Record(Type.String(), StackInfo),
  limits: Type.Object({
    memoryMaxBytes: Type.Integer(),
    cpuQuotaPercent: Type.Integer(),
    tasksMax: Type.Integer(),
  }),
  isolation: Type.Object({
    bwrap: Type.Boolean(),
    uid: Type.Integer(),
  }),
  git: Type.Object({
    isRepo: Type.Boolean(),
    branch: Type.Optional(Type.String()),
  }),
});

export type WorkspaceResT = Static<typeof WorkspaceRes>;
