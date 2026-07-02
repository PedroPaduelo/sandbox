type WatcherEntry = { unsubscribe: () => void; socket: import('ws').WebSocket };
const active = new Set<WatcherEntry>();

export function register(e: WatcherEntry): void { active.add(e); }
export function unregister(e: WatcherEntry): void { active.delete(e); }
export function getActive(): Set<WatcherEntry> { return active; }
export async function closeAllWatchers(): Promise<void> {
  for (const e of active) {
    try { e.unsubscribe(); e.socket.close(1001, 'server shutting down'); } catch {}
  }
  active.clear();
}