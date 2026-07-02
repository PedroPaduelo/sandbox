/**
 * Isolamento de processos filhos via bubblewrap (bwrap).
 *
 * Cada run_command/start_process roda dentro de um conjunto de namespaces
 * separados do processo do sandbox-agent:
 *
 * - PID namespace:   filho vê só ele mesmo como PID 1, não consegue matar
 *                    o sandbox-agent nem ver outros processos do container.
 * - Mount namespace: /app (onde vive o código do sandbox-agent) é INVISÍVEL;
 *                    /usr, /bin, /lib são read-only; só /workspace e o $HOME
 *                    do user são read-write.
 * - IPC/UTS:         sem acesso a IPC compartilhada nem ao hostname do host.
 * - `/tmp` tmpfs fresh por processo.
 * - `--clearenv` + `--setenv` explícitos: zero env herdado.
 * - `--die-with-parent`: se o sandbox-agent cair, o filho morre junto.
 * - `--new-session`: sinais (Ctrl-C, SIGTERM) não atravessam.
 *
 * Rede é COMPARTILHADA (`--share-net`) intencionalmente — `npm install`,
 * `curl`, `git fetch` precisam. O processo não consegue bindar em localhost
 * conflitante com o sandbox-agent porque o sandbox-agent escuta em 0.0.0.0
 * e o filho em um PID namespace diferente (não vê nada além dele).
 */

import { spawn } from 'node:child_process';
import { MAIN_WORKTREE, WORKTREES_BASE } from '../workspace.js';
import { binAvailable } from './bin.js';

export interface BwrapOpts {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Monta a lista de args do bwrap ANTES do `--`. Depois o chamador concatena
 * `['--', bin, ...args]` e o spawn do bwrap executa `bin` isolado.
 */
export function buildBwrapArgs(opts: BwrapOpts): string[] {
  const home = opts.env.HOME ?? '/home/sandbox';
  const args: string[] = [
    // Namespaces completos. Quando o container roda com cap_add:SYS_ADMIN
    // (Compose Service), esses flags funcionam. O runtime detection em
    // bwrapAvailable() cuida de desabilitar tudo se o kernel bloquear.
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    // mantém rede do host (npm install, git, curl)
    '--share-net',
    // disciplina
    '--die-with-parent',
    '--new-session',
    // obs: drop de privilégio (uid/gid) é feito via `setpriv` no leafCmd
    // (ver wrapWithDropPriv). --uid nativo do bwrap exigiria --unshare-user
    // que volta a depender de unprivileged userns (bloqueado no host).
    // Filesystem — read-only do sistema
    '--ro-bind', '/usr', '/usr',
    '--ro-bind-try', '/bin', '/bin',
    '--ro-bind-try', '/sbin', '/sbin',
    '--ro-bind-try', '/lib', '/lib',
    '--ro-bind-try', '/lib32', '/lib32',
    '--ro-bind-try', '/lib64', '/lib64',
    // /etc inteiro read-only — DNS (resolv.conf/nsswitch/hosts), TLS
    // (ssl/ca-certificates), user info (passwd/group) tudo de uma vez. Read-only
    // garante que o filho não altera nada. Bindar arquivos individuais dava
    // "Permission denied" porque /etc como diretório não estava montado.
    '--ro-bind', '/etc', '/etc',
    '--ro-bind-try', '/usr/share/ca-certificates', '/usr/share/ca-certificates',
    // Read-write — /workspace (main worktree + .git central) e /wt
    // (worktrees por-chat da Fase 2). Cada worktree em /wt/<id> tem um
    // arquivo `.git` que aponta pra /workspace/.git/worktrees/<id>, então
    // o git só funciona se AMBOS os caminhos estiverem acessíveis dentro
    // do namespace. /home inteiro pra $HOME do sandbox-user ser escrivível
    // (bindar só /home/sandbox fazia bwrap criar /home como 700 root:root,
    // bloqueando traversal do uid 1001).
    '--bind', MAIN_WORKTREE, MAIN_WORKTREE,
    '--bind-try', WORKTREES_BASE, WORKTREES_BASE,
    '--bind', '/home', '/home',
    // tmpfs fresh por processo — isola /tmp entre filhos.
    // --perms 01777 (sticky + rwx all) é o padrão de /tmp em Linux, senão
    // o tmpfs herda 0755 root:root e uid 1001 não consegue mkdir lá (Go
    // build cache, npm tmp, etc. falham).
    '--perms', '01777',
    '--tmpfs', '/tmp',
    // /proc e /dev novos (do PID/mount namespace novo)
    '--proc', '/proc',
    '--dev', '/dev',
    // Env completamente limpo; só o que for setado via --setenv aparece
    '--clearenv',
  ];

  // Injeta env explicitamente — redundante com `spawn({ env })` mas garante
  // que `--clearenv` acima não apague nada do que a gente quer.
  for (const [k, v] of Object.entries(opts.env)) {
    if (v === undefined || v === '') continue;
    args.push('--setenv', k, String(v));
  }

  args.push('--chdir', opts.cwd);
  return args;
}

let bwrapChecked: boolean | null = null;
/**
 * Testa em runtime se bwrap REALMENTE consegue criar namespaces neste ambiente.
 * Só ter o binário não basta — Docker App Service do EasyPanel tem bwrap
 * instalado mas sem SYS_ADMIN o unshare() falha. Aqui fazemos um dry-run pra
 * detectar e cachear. Falha = fallback gracioso pra setpriv+env-clean puros.
 */
export async function bwrapAvailable(): Promise<boolean> {
  if (bwrapChecked !== null) return bwrapChecked;
  const hasBin = await binAvailable('bwrap');
  if (!hasBin) { bwrapChecked = false; return false; }
  bwrapChecked = await new Promise<boolean>((resolve) => {
    // invocação mínima — se o kernel bloquear, exit != 0
    const p = spawn('bwrap', ['--ro-bind', '/', '/', '--', '/bin/true'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
  return bwrapChecked;
}

let setprivChecked: boolean | null = null;
export async function setprivAvailable(): Promise<boolean> {
  if (setprivChecked !== null) return setprivChecked;
  setprivChecked = await binAvailable('setpriv');
  return setprivChecked;
}

/**
 * Envelopa o comando leaf num `setpriv` que dropa pra uid/gid 1001 (user
 * `sandbox`). Isso garante que o processo filho roda como não-root mesmo o
 * sandbox-agent rodando como root (precisa de root pra criar namespaces sem
 * unprivileged userns).
 *
 * Se setpriv não estiver disponível, devolve o leafCmd cru (processo filho
 * vai rodar como root dentro do namespace — isolamento de FS/PID ainda
 * funciona, mas perde a camada de drop de privilégio).
 */
export async function wrapWithDropPriv(leafCmd: string[]): Promise<string[]> {
  const hasSetpriv = await setprivAvailable();
  if (!hasSetpriv) return leafCmd;
  return ['setpriv', '--reuid=1001', '--regid=1001', '--init-groups', '--', ...leafCmd];
}
