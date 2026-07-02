import { Type } from '@sinclair/typebox';

/**
 * POST /api/v1/exec/run — executa comando bash síncrono no workspace.
 * Mesma semântica do MCP run_command (timeout 30s, stdout ≤8KB, stderr ≤4KB).
 */
export const ExecRunReq = Type.Object({
  cmd: Type.String({
    minLength: 1,
    description: 'Comando bash (ex: "npm test", "git status")',
  }),
  cwd: Type.Optional(
    Type.String({
      maxLength: 4096,
      description: 'Subdiretório relativo ao workspace',
    }),
  ),
});

export const ExecRunRes = Type.Object({
  cmd: Type.String(),
  cwd: Type.String(),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  stdout: Type.String(),
  stderr: Type.String(),
  truncated: Type.Boolean(),
  timedOut: Type.Boolean(),
  isolated: Type.Boolean(),
});
