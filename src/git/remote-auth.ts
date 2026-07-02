/**
 * Helper compartilhado por todas as operações que falam com o remote (pull/
 * push/fetch/publish): injeta o token via git credential helper durante a
 * execução de `op` e SEMPRE re-seta a URL plain no `finally`, mesmo se `op`
 * lançar.
 *
 * Núcleo de segurança: garante que o PAT nunca persiste em `.git/config`,
 * mesmo em caminhos de erro.
 */

import { getOriginUrl, setRemoteUrl, RemoteUrlError } from './remote-url.js';
import { GitSyncError } from './sync-error.js';
import { gitCredStore } from './cred-context.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, chownSync } from 'node:fs';

const REMOTE_URL_TIMEOUT_MS = 10_000;

export async function withAuthenticatedRemote<T>(
  cwd: string,
  token: string | undefined,
  op: () => Promise<T>,
): Promise<T> {
  let plainUrl: string;
  try {
    plainUrl = await getOriginUrl(cwd, REMOTE_URL_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof RemoteUrlError && err.code === 'NO_ORIGIN') {
      throw new GitSyncError('origin remote not configured', 'NOT_A_REPO');
    }
    if (err instanceof RemoteUrlError) {
      throw new GitSyncError(err.message, 'GIT_FAILED');
    }
    throw err;
  }

  if (!token) {
    return op();
  }

  // Prepara o credential helper em tmpfs (não persiste em disco).
  //
  // CORREÇÃO de 2 bugs (2026-05-23):
  //
  // 1. `process.env.GIT_CREDENTIAL_HELPER` NÃO existe no git. Era invenção
  //    e git ignorava. O caminho oficial pra injetar config via env é
  //    `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_n` + `GIT_CONFIG_VALUE_n`
  //    (suportado desde git 2.31, jul/2021).
  //
  // 2. O script lia stdin esperando `url=...`, mas git credential protocol
  //    envia (pra get): `protocol=https\nhost=github.com\npath=...\n<blank>`.
  //    Não tem `url=`, daí o script nunca respondia → git ficava sem creds.
  //    Reescrito pra drenar stdin até blank line e responder username/password.
  //
  // Resultado do bug antigo: TODO push/pull/fetch falhava com "could not
  // read Username for 'https://github.com': terminal prompts disabled".
  const tmp = mkdtempSync(join(tmpdir(), 'git-cred-'));
  const helperPath = join(tmp, 'cred-helper.sh');
  // Escape do token pra shell: substitui ' por '"'"' (encerra string, escape
  // literal, reabre string). Suficiente porque PAT do GitHub é
  // [A-Za-z0-9_], mas defensivo.
  const escapedToken = token.replace(/'/g, "'\"'\"'");
  const sh = [
    '#!/bin/sh',
    '# git credential helper — responde GET com x-access-token + token PAT.',
    'op="$1"',
    'if [ "$op" != "get" ]; then exit 0; fi',
    '# Drena stdin (protocol=...\\nhost=...\\n...\\n<blank line>)',
    'while IFS= read -r line && [ -n "$line" ]; do :; done',
    'echo "username=x-access-token"',
    `echo 'password=${escapedToken}'`,
  ].join('\n');

  writeFileSync(helperPath, sh, { mode: 0o700 });
  // git agora roda como uid 1001 (ver clone.ts) → precisa ler/executar o
  // helper. chown best-effort; root (fallback sem setpriv) lê de qualquer modo.
  try {
    chownSync(tmp, 1001, 1001);
    chownSync(helperPath, 1001, 1001);
  } catch {
    /* best-effort */
  }

  try {
    // Configura remote com plainUrl antes de operar (evita que git logue o token).
    await setRemoteUrl(cwd, plainUrl, REMOTE_URL_TIMEOUT_MS);

    // C-11: injeta credential.helper via env vars OFICIAIS do git, mas num
    // AsyncLocalStorage POR-CONTEXTO (não no process.env global). Os runGit
    // mesclam `gitCredEnv()` no spawn — então dois pushes concorrentes têm,
    // cada um, seu próprio helperPath e seu próprio store, sem se sobrescrever.
    const credEnv: Record<string, string> = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: helperPath,
    };
    return await gitCredStore.run(credEnv, async () => {
      try {
        return await op();
      } finally {
        // Sempre volta o plainUrl, mesmo se `op` lançou. Best-effort.
        try {
          await setRemoteUrl(cwd, plainUrl, REMOTE_URL_TIMEOUT_MS);
        } catch {
          /* swallow: erro original (de op) tem prioridade */
        }
      }
    });
  } finally {
    try { unlinkSync(helperPath); } catch { /* best-effort */ }
    try { rmdirSync(tmp); } catch { /* best-effort */ }
  }
}
