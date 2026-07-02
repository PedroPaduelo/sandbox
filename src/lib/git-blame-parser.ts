/**
 * Parser for `git blame --porcelain` output.
 *
 * Porcelain format per `git-blame(1)`:
 *   - Each line begins with a 40-char SHA header:
 *       `<sha> <origLine> <finalLine> [<numLines>]`
 *   - The FIRST time a commit appears, it is followed by extra header fields:
 *       author, author-mail, author-time, author-tz,
 *       committer, committer-mail, committer-time, committer-tz,
 *       summary, previous (optional), filename
 *   - Subsequent appearances of the same SHA only repeat the SHA header
 *     (no extra header fields) — the parser must cache metadata by hash.
 *   - The CONTENT line is preceded by a TAB character ("\t<line>").
 */

export interface BlameLine {
  line: number;
  hash: string;
  author: string;
  date: string;
  summary: string;
}

interface CommitMeta {
  author: string;
  date: string;
  summary: string;
}

const HASH_HEADER = /^([0-9a-f]{40})\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/;

export function parseGitBlamePorcelain(output: string): BlameLine[] {
  const lines = output.split('\n');
  const meta = new Map<string, CommitMeta>();
  const result: BlameLine[] = [];

  let i = 0;
  while (i < lines.length) {
    const header = HASH_HEADER.exec(lines[i]);
    if (!header) {
      i++;
      continue;
    }
    const hash = header[1];
    const finalLine = parseInt(header[2], 10);
    i++;

    let author = meta.get(hash)?.author ?? '';
    let date = meta.get(hash)?.date ?? '';
    let summary = meta.get(hash)?.summary ?? '';

    // Read optional header fields until we hit the tab-prefixed content line.
    while (i < lines.length && !lines[i].startsWith('\t')) {
      const cur = lines[i];
      if (cur.startsWith('author ')) {
        author = cur.slice('author '.length);
      } else if (cur.startsWith('author-time ')) {
        const ts = parseInt(cur.slice('author-time '.length), 10);
        if (Number.isFinite(ts)) {
          date = new Date(ts * 1000).toISOString();
        }
      } else if (cur.startsWith('summary ')) {
        summary = cur.slice('summary '.length);
      }
      i++;
    }

    if (!meta.has(hash)) {
      meta.set(hash, { author, date, summary });
    }

    // The content line (we don't actually need it for BlameLine, but advance).
    if (i < lines.length && lines[i].startsWith('\t')) {
      i++;
    }

    result.push({ line: finalLine, hash, author, date, summary });
  }

  return result;
}
