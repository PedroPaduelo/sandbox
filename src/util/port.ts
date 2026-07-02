import { spawn } from 'node:child_process';
import { binAvailable } from './bin.js';

/**
 * Descoberta de processos por porta TCP. Usado por `restart_managed_process`
 * (F1.3) pra matar processos que estão segurando uma porta de exposed service
 * — inclusive processos que NÃO foram criados via `start_process` (e portanto
 * não estão no `bgProcesses` Map). Cobre o caso patológico de processo orfão
 * ou iniciado direto via shell.
 *
 * Estratégia: tenta `ss` primeiro (mais leve, faz parte do iproute2 em quase
 * toda distro), fallback `lsof`. Se nenhum dos dois estiver disponível,
 * retorna null — caller decide se aceita "porta talvez ocupada" como ok.
 */

export interface ProcessOnPort {
  pid: number;
}

function tryRunCaptureStdout(
  bin: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const p = spawn(bin, args);
    let out = '';
    p.stdout?.on('data', (d) => (out += d.toString()));
    p.on('error', () => resolve({ ok: false, stdout: '' }));
    p.on('close', (code) => resolve({ ok: code === 0, stdout: out }));
  });
}

/**
 * Retorna PID do processo bound em `port` (LISTEN, TCP). Null se nada lá ou
 * se nem `ss` nem `lsof` estiverem disponíveis.
 */
export async function findProcessOnPort(port: number): Promise<ProcessOnPort | null> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  // 1) ss — formato: `users:(("node",pid=1234,fd=22))`
  if (await binAvailable('ss')) {
    const r = await tryRunCaptureStdout('ss', ['-Hltnp', `sport = :${port}`]);
    if (r.ok && r.stdout) {
      const m = /pid=(\d+),/.exec(r.stdout);
      if (m) {
        const pid = parseInt(m[1], 10);
        if (!isNaN(pid)) return { pid };
      }
    }
  }

  // 2) lsof — `-t` imprime só o PID, um por linha
  if (await binAvailable('lsof')) {
    const r = await tryRunCaptureStdout('lsof', [
      '-t',
      `-iTCP:${port}`,
      '-sTCP:LISTEN',
    ]);
    if (r.ok && r.stdout.trim()) {
      const pid = parseInt(r.stdout.trim().split('\n')[0], 10);
      if (!isNaN(pid)) return { pid };
    }
  }

  return null;
}

/**
 * Bloqueia até `port` estar livre, ou timeout. Poll 200ms. Retorna true se
 * liberou, false se estourou. Usado depois de SIGKILL pra evitar EADDRINUSE
 * na próxima tentativa de bind.
 */
export async function waitPortFree(
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const owner = await findProcessOnPort(port);
    if (!owner) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  // Última checagem após timeout
  return (await findProcessOnPort(port)) === null;
}
