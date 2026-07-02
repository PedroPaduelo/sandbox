/**
 * Provedor de credenciais Git via `git credential`.
 *
 * Problema: git moderno (2.36+) com GIT_TERMINAL_PROMPT=0 não extrai
 * credenciais de URLs HTTPS com @user:pass@ (proteção anti-vazamento em logs).
 *
 * Solução: git credential helper via subprocesso. O helper lê o protocolo/
 * host/path da URL e responde o username/password para git, que então usa
 * para a autenticação — sem nunca colocar o token na URL.
 *
 * Funciona com: clone, fetch, pull, push, ls-remote — qualquer operação git
 * que fale com remote HTTPS autenticado.
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, chownSync } from 'node:fs';
import { wrapWithDropPriv } from '../util/sandbox.js';

export type GitCredentialCode =
  | 'AUTH_FAILED'
  | 'REPO_NOT_FOUND'
  | 'TIMEOUT'
  | 'WORKSPACE_DIRTY'
  | 'REMOTE_MISMATCH'
  | 'GIT_FAILED';

export interface GitAuthResult {
  ok: true;
  stdout: string;
  stderr: string;
}

export interface GitAuthFail {
  ok: false;
  code: GitCredentialCode;
  message: string;
}

function classifyStderr(stderr: string): GitCredentialCode {
  if (/authentication failed|invalid username or token|could not read username/i.test(stderr))
    return 'AUTH_FAILED';
  if (/repository not found|does not exist|could not read from remote/i.test(stderr))
    return 'REPO_NOT_FOUND';
  return 'GIT_FAILED';
}

/**
 * Executa `args` (comando git) com o token fornecido via git credential helper.
 *
 * Cria um helper script temporário em /tmp (tmpfs) que:
 * 1. Recebe "url=..." do git via stdin
 * 2. Devolve "username=x-access-token\npassword=<token>\n\n" para git
 * 3. É removido após a operação (mesmo em caso de erro)
 *
 * @param args    - argumentos git (ex.: ['clone', '--depth=1', 'url', 'dest'])
 * @param opts    - cwd, timeoutMs, stdin, token (PAT), url (plain HTTPS URL)
 */
export async function runGitWithAuth(
  args: string[],
  opts: { cwd?: string; timeoutMs: number; stdin?: string; token: string; url: string },
): Promise<GitAuthResult | GitAuthFail> {
  // git roda como uid 1001 (uniformidade de ownership do .git — ver clone.ts).
  // O wrap é resolvido fora do Promise pra poder await.
  const wrapped = await wrapWithDropPriv(['git', ...args]);
  return new Promise((resolve) => {
    const tmp = mkdtempSync(join(tmpdir(), 'git-cred-'));
    const helperPath = join(tmp, 'cred-helper.sh');

    // sh script que alimenta git credential com as credenciais.
    // Formato: git credential.fill lê url de stdin, helper responde username/password.
    const sh = [
      '#!/bin/sh',
      `url="${opts.url.replace(/"/g, '\\"')}"`,
      'username="x-access-token"',
      `password="${opts.token.replace(/'/g, "'\\''")}"`,
      'while IFS= read -r line || [ -n "$line" ]; do',
      '  case "$line" in',
      '    url=*)',
      '      echo "url=$url"',
      '      echo "username=$username"',
      '      echo "password=$password"',
      '      echo',
      '      exit 0',
      '      ;;',
      '    *)',
      '      ;;',
      '  esac',
      'done',
      'exit 0',
    ].join('\n');

    writeFileSync(helperPath, sh, { mode: 0o700 });
    // git roda como 1001 → precisa ler/executar o helper. chown best-effort;
    // se falhar (ou git rodar root no fallback sem setpriv), root lê de qualquer jeito.
    try {
      chownSync(tmp, 1001, 1001);
      chownSync(helperPath, 1001, 1001);
    } catch {
      /* best-effort */
    }

    const [bin, ...binArgs] = wrapped;
    const p = spawn(bin, binArgs, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        HOME: '/home/sandbox',
        USER: 'sandbox',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CREDENTIAL_HELPER: helperPath,
      },
      stdio: opts.stdin !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, opts.timeoutMs);

    p.stdout?.on('data', (d) => (stdout += d.toString()));
    p.stderr?.on('data', (d) => (stderr += d.toString()));

    p.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 'GIT_FAILED', message: err.message });
      cleanup(tmp, helperPath);
    });

    p.on('close', (code) => {
      clearTimeout(timer);
      cleanup(tmp, helperPath);
      if (timedOut) return resolve({ ok: false, code: 'TIMEOUT', message: 'git timeout' });
      if (code === 0) return resolve({ ok: true, stdout, stderr });
      const errCode = classifyStderr(stderr);
      resolve({ ok: false, code: errCode, message: stderr.trim() || `git exit ${code}` });
    });

    if (opts.stdin !== undefined && p.stdin) {
      p.stdin.end(opts.stdin);
    }
  });
}

function cleanup(tmp: string, helperPath: string) {
  try { unlinkSync(helperPath); } catch { /* best-effort */ }
  try { rmdirSync(tmp); } catch { /* best-effort */ }
}
