import { Type } from '@sinclair/typebox';

export const MergeChatBranchReq = Type.Object({
  conversationId: Type.String({ minLength: 1, maxLength: 64 }),
  branchName: Type.String({ minLength: 1, maxLength: 255 }),
  token: Type.Optional(Type.String()),
  targetBranch: Type.Optional(Type.String({ maxLength: 255 })),
});

export const MergeIntoParentReq = Type.Object({
  conversationId: Type.String({ minLength: 1, maxLength: 64 }),
  branchName: Type.String({ minLength: 1, maxLength: 255 }),
  targetBranch: Type.String({ minLength: 1, maxLength: 255 }),
  targetConversationId: Type.String({ minLength: 1, maxLength: 64 }),
});

export const MergeFlowResultSchema = Type.Object({
  status: Type.Union([
    Type.Literal('MERGED'),
    Type.Literal('CONFLICT'),
    Type.Literal('DIRTY'),
    Type.Literal('FAILED'),
  ]),
  commitSha: Type.Optional(Type.String()),
  conflictFiles: Type.Optional(Type.Array(Type.String())),
  error: Type.Optional(Type.String()),
  attempts: Type.Integer(),
});

export const CompleteMergeReq = Type.Object({
  // C-2: identifica o chat/branch cujo merge está sendo completado, pra o
  // servidor VALIDAR que o merge em curso no MAIN_WORKTREE é mesmo desta
  // branch (com 2 chats em CONFLICT, antes podia completar o errado).
  conversationId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  branchName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  token: Type.Optional(Type.String()),
  targetBranch: Type.Optional(Type.String({ maxLength: 255 })),
});

export const CleanupAfterMergeReq = Type.Object({
  conversationId: Type.String({ minLength: 1, maxLength: 64 }),
  branchName: Type.String({ minLength: 1, maxLength: 255 }),
});

export const CleanupAfterMergeRes = Type.Object({
  ok: Type.Boolean(),
});
