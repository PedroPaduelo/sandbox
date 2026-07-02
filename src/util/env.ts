/**
 * Constrói um env limpo pra processos filhos (run_command, start_process).
 *
 * Pai (o sandbox-agent) tem ENVs como SANDBOX_TOKEN, SANDBOX_MEMORY_MAX,
 * PORT, WORKSPACE, NODE_ENV=production (setado pelo Dockerfile), etc. Se
 * a gente herdar tudo via `spawn(...)` sem passar `env:`, essas variáveis
 * contaminam o projeto do usuário — ex.: `NODE_ENV=production` faz o
 * `npm install` pular devDependencies e o `next build` falhar.
 *
 * Regra: isolamento por allowlist. Só passa o mínimo pra shell funcionar.
 * Variáveis que ajudam ambientes de dev (desativar telemetria) vão como
 * overrides opt-in abaixo.
 */

const PASSTHROUGH_VARS = [
  // PATH não vem daqui — usamos um PATH fixo e limpo abaixo, pra não herdar
  // node_modules/.bin do sandbox-agent.
  'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'TERM', 'TZ', 'PWD',
  'TMPDIR', 'TEMP', 'TMP',
];

const CLEAN_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export function buildCleanEnv(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_VARS) {
    const val = process.env[key];
    if (val !== undefined) clean[key] = val;
  }
  // passa LC_* extras (locales variam por distro)
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('LC_') && !(key in clean)) {
      clean[key] = process.env[key];
    }
  }
  // PATH limpo — não herda node_modules/.bin do sandbox-agent
  clean.PATH = CLEAN_PATH;

  // Força identidade do user-sandbox (não herda /root do container).
  // Sem isso, bash tenta ler /root/.bashrc e falha com "Permission denied"
  // dentro do bwrap pq uid 1001 não lê /root.
  clean.HOME = '/home/sandbox';
  clean.USER = 'sandbox';
  clean.LOGNAME = 'sandbox';

  // defaults sensatos que ajudam projetos de dev (não vazam nada sensível)
  clean.NEXT_TELEMETRY_DISABLED = '1';
  clean.ADBLOCK = '1';          // silencia banners de pacotes
  clean.DISABLE_OPENCOLLECTIVE = '1';
  clean.CI = '';                // deixa ferramentas assumirem "interativo"
  // Caches ficam em $HOME (default de npm/pip/cargo/gradle/etc). Dá persistência
  // entre processos do MESMO container — npm não re-baixa tudo a cada install.
  // $HOME é bindado rw (/home/sandbox) e uid 1001 pode escrever nele porque o
  // sandbox-agent faz chown -R sandbox:sandbox /home/sandbox no startup.
  if (overrides) Object.assign(clean, overrides);
  return clean;
}
