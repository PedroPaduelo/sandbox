/**
 * Parser for `git status --porcelain` output focused on merge conflicts.
 *
 * Conflict status codes (XY):
 *   UU  both modified
 *   AA  both added
 *   DD  both deleted
 *   AU  added by us
 *   UA  added by them
 *   DU  deleted by us
 *   UD  deleted by them
 *
 * Format (porcelain v1):
 *   `<XY> <path>` — one entry per line. `XY` is exactly 2 chars followed by a
 *   space. For renames, path is `orig -> new` (rename never conflicts so we
 *   don't worry about that here).
 */

const CONFLICT_CODES = new Set([
  'UU',
  'AA',
  'DD',
  'AU',
  'UA',
  'DU',
  'UD',
]);

export function parseConflictPaths(out: string): string[] {
  const result: string[] = [];
  for (const raw of out.split('\n')) {
    if (raw.length < 4) continue;
    const xy = raw.slice(0, 2);
    if (raw[2] !== ' ') continue;
    if (!CONFLICT_CODES.has(xy)) continue;
    const path = raw.slice(3).trim();
    if (path) result.push(path);
  }
  return result;
}
