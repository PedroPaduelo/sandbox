import chokidar, { FSWatcher } from 'chokidar';
import { getWorktreePath, resolveSafe, toRelative } from '../workspace.js';

const DEFAULT_IGNORED = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/.next/**',
  '**/build/**', '**/coverage/**', '**/.turbo/**', '**/.cache/**',
  '**/__pycache__/**', '**/.venv/**', '**/venv/**',
];

export interface WatchEvent {
  type: 'created' | 'modified' | 'deleted';
  path: string;
  mtime?: string;
}

export type WatchListener = (e: WatchEvent) => void;

export interface Watch {
  unsubscribe(): void;
  add(paths: string[]): void;
  remove(paths: string[]): void;
}

export function watchPaths(initialPaths: string[], listener: WatchListener): Watch {
  const absInitial = initialPaths.length
    ? initialPaths.map((p) => resolveSafe(p))
    : [getWorktreePath()];

  const watcher: FSWatcher = chokidar.watch(absInitial, {
    ignored: DEFAULT_IGNORED,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
  });

  watcher
    .on('add',    (p) => listener({ type: 'created',  path: toRelative(p) }))
    .on('change', (p, st) => listener({ type: 'modified', path: toRelative(p), mtime: st?.mtime?.toISOString() }))
    .on('unlink', (p) => listener({ type: 'deleted',  path: toRelative(p) }));

  return {
    unsubscribe() { void watcher.close(); },
    add(paths) { watcher.add(paths.map((p) => resolveSafe(p))); },
    remove(paths) { watcher.unwatch(paths.map((p) => resolveSafe(p))); },
  };
}
