import { spawn } from 'node:child_process';

const cache = new Map<string, boolean>();

export async function binAvailable(name: string): Promise<boolean> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  return await new Promise<boolean>((resolve) => {
    const proc = spawn('which', [name], { stdio: 'ignore' });
    proc.on('error', () => {
      cache.set(name, false);
      resolve(false);
    });
    proc.on('close', (code) => {
      const ok = code === 0;
      cache.set(name, ok);
      resolve(ok);
    });
  });
}
