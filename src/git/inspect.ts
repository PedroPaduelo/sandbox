import { readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

export type WorkspaceAction = 'clone' | 'update' | 'mismatch' | 'dirty';

export interface InspectResult {
  action: WorkspaceAction;
  currentRemote?: string;
}

function normalizeUrl(u: string): string {
  return u.replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
}

function getOriginRemote(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn('git', ['remote', 'get-url', 'origin'], { cwd });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 ? out.trim() : null));
  });
}

export async function inspectWorkspace(
  workspaceRoot: string,
  expectedUrl: string,
): Promise<InspectResult> {
  let entries: string[];
  try {
    entries = await readdir(workspaceRoot);
  } catch {
    return { action: 'clone' };
  }
  if (entries.length === 0) return { action: 'clone' };

  const gitDir = path.join(workspaceRoot, '.git');
  let hasGit = false;
  try {
    await stat(gitDir);
    hasGit = true;
  } catch {}

  if (!hasGit) return { action: 'dirty' };

  const remote = await getOriginRemote(workspaceRoot);
  if (!remote) return { action: 'mismatch' };

  if (normalizeUrl(remote) === normalizeUrl(expectedUrl)) {
    return { action: 'update', currentRemote: remote };
  }
  return { action: 'mismatch', currentRemote: remote };
}
