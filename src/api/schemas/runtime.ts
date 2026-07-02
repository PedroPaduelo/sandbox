import { Type } from '@sinclair/typebox';

export const ActiveRuntimeRes = Type.Object({
  activeWorktreePath: Type.Union([Type.String(), Type.Null()]),
  activeConversationId: Type.Union([Type.String(), Type.Null()]),
  startedAt: Type.Union([Type.Integer(), Type.Null()]),
  activeServices: Type.Array(
    Type.Object({
      label: Type.String(),
      processId: Type.String(),
    }),
  ),
});

export const StopRuntimeRes = Type.Object({
  stopped: Type.Array(Type.String()),
});
