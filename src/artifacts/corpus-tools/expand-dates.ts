// Resolve seed dates from frontmatter, batched Git addition history, then filesystem mtime.
import { statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { boundedExecFileSync } from '../../process/bounded-child-process.mjs';
import type { CorpusIdentityRecord } from './resolve-corpus.js';

function frontmatterDate(record: CorpusIdentityRecord): number | undefined {
  for (const fields of record.fields) {
    const discovery = fields.discovery as Record<string, unknown> | undefined;
    for (const value of [fields.inducted, fields.inducted_on, fields.added, fields.created, fields.date, discovery?.date]) {
      const date = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
      if (Number.isFinite(date)) return date;
    }
  }
  return undefined;
}

function gitAdditionDates(root: string, records: CorpusIdentityRecord[]): { dates: Map<string, number>; shallow: boolean } {
  const dates = new Map<string, number>();
  let shallow = false;
  const git = (cwd: string, args: string[]) => String(boundedExecFileSync('git', args, 'quick', {
    cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  try {
    const repository = git(root, ['rev-parse', '--show-toplevel']).trim();
    shallow = git(repository, ['rev-parse', '--is-shallow-repository']).trim() === 'true';
    const tracked = new Set(git(repository, ['ls-files', '-z']).split('\0'));
    const pending = new Map<string, string[]>();
    for (const record of records) {
      const path = relative(repository, resolve(record.path)).split(sep).join('/');
      if (tracked.has(path)) pending.set(path, [record.path]);
    }
    if (!pending.size) return { dates, shallow };
    // Walk backwards through renames without a pathspec: predecessors may live outside the corpus.
    // NUL-delimited paths also handle spaces, tabs, newlines and Git's quoted-path syntax.
    // Combined diffs expose merge-created files (AA), but omit additions inherited from a
    // parent: those resolve at their original branch commit, not at the merge date.
    const tokens = git(repository, ['log', '--topo-order', '--full-history', '--diff-merges=combined',
      '--format=%x00aiwg-date:%aI %P%x00',
      '--name-status', '-z', '--find-renames', '--diff-filter=AR', '--']).split('\0');
    let date = NaN;
    for (let i = 0; i < tokens.length && pending.size; i++) {
      const token = tokens[i].replace(/^\n+/, '');
      if (token.startsWith('aiwg-date:')) {
        const [authored, parents] = token.slice(10).split(' ');
        // A shallow boundary masquerades as a root addition; its true date is unknown.
        date = shallow && !parents ? NaN : Date.parse(authored);
        continue;
      }
      if (/^A+$/.test(token)) {
        const path = tokens[++i];
        if (Number.isFinite(date)) for (const original of pending.get(path) ?? []) dates.set(original, date);
        pending.delete(path);
      } else if (/^R\d+$/.test(token)) {
        const oldPath = tokens[++i];
        const newPath = tokens[++i];
        const originals = pending.get(newPath);
        if (originals) {
          pending.delete(newPath);
          pending.set(oldPath, [...(pending.get(oldPath) ?? []), ...originals]);
        }
      }
    }
  } catch {
    // Missing Git, no repository, unavailable history or a bounded query failure use the same fallback.
    return { dates: new Map(), shallow };
  }
  return { dates, shallow };
}

export function expansionDates(root: string, records: CorpusIdentityRecord[]): Map<string, number> {
  const dates = new Map<string, number>();
  const missing: CorpusIdentityRecord[] = [];
  for (const record of records) {
    const date = frontmatterDate(record);
    if (date === undefined) missing.push(record);
    else dates.set(record.path, date);
  }
  const { dates: additions, shallow } = missing.length ? gitAdditionDates(root, missing) : { dates: new Map<string, number>(), shallow: false };
  let mtimeCount = 0;
  for (const record of records) {
    try {
      const mtime = statSync(record.path).mtimeMs;
      if (dates.has(record.path)) continue;
      const date = additions.get(record.path);
      if (date === undefined) mtimeCount++;
      dates.set(record.path, date ?? mtime);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      dates.delete(record.path);
      console.warn(`[aiwg] corpus expand --since: ${record.ref} document disappeared; skipping seed (${record.path}).`);
    }
  }
  if (mtimeCount) console.warn(`[aiwg] corpus expand --since: ${mtimeCount} REFs used document mtime because no Git first-add date was available.${shallow ? ' Shallow Git history may omit first additions; use a full clone for stable --since scoping.' : ''}`);
  return dates;
}
