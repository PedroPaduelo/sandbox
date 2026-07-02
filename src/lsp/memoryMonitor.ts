import { readFile } from 'node:fs/promises';

/**
 * Lê RSS (Resident Set Size) em bytes de um processo Linux via `/proc/<pid>/status`.
 *
 * Retorna `undefined` se o arquivo não existir (processo morreu) ou se o campo
 * `VmRSS` não estiver presente. Linux-only — sandbox-agent roda em container Linux.
 */
export type ReadRssFn = (pid: number) => Promise<number | undefined>;

export const defaultReadRss: ReadRssFn = async (pid) => {
  let raw: string;
  try {
    raw = await readFile(`/proc/${pid}/status`, 'utf8');
  } catch {
    return undefined;
  }
  // VmRSS line example: "VmRSS:\t  12345 kB"
  const m = /^VmRSS:\s*(\d+)\s*kB$/m.exec(raw);
  if (!m) return undefined;
  const kb = Number(m[1]);
  if (!Number.isFinite(kb)) return undefined;
  return kb * 1024;
};
