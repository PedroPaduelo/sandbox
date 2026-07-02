export function parseSizeBytes(s: string | undefined, defaultStr: string): number {
  const raw = (s ?? defaultStr).toString();
  const m = /^(\d+)([KMGT]?)$/i.exec(raw);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const mul: Record<string, number> = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return n * mul[m[2].toUpperCase()];
}

export function parsePercent(s: string | undefined, def: number): number {
  if (!s) return def;
  return parseInt(s.replace("%", ""), 10) || def;
}
