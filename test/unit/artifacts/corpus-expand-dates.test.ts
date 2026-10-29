// Exercise fresh-clone date scoping with real, isolated Git history and bounded process calls.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { boundedExecFileSync } from '../../../src/process/bounded-child-process.mjs';
import { expansionDates } from '../../../src/artifacts/corpus-tools/expand-dates.js';
import { expandCorpus } from '../../../src/artifacts/corpus-tools/expand.js';
import { EXPAND_USAGE, type ExpandOptions } from '../../../src/artifacts/corpus-tools/expand-cli.js';
import { loadCorpusIdentities, type CorpusIdentityRecord } from '../../../src/artifacts/corpus-tools/resolve-corpus.js';

vi.mock('../../../src/process/bounded-child-process.mjs', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/process/bounded-child-process.mjs')>();
  return { ...actual, boundedExecFileSync: vi.fn(actual.boundedExecFileSync) };
});

let temporary: string;
let repository: string;
let root: string;
let warning: ReturnType<typeof vi.spyOn>;
const now = new Date('2026-10-29T12:00:00Z');
const since = Date.parse('2026-09-01');
const options: ExpandOptions = { since, perSeed: 20, from: 'recent', minYear: 2018,
  reexploreMs: 180 * 86400000, maxSeeds: 100, overlap: false, write: false, json: true };

function git(args: string[], date = '2026-01-24T12:00:00Z') {
  return boundedExecFileSync('git', args, 'quick', { cwd: repository, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
}
function commit(date?: string) { git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], date); }
function seed(ref: string, fields = '') {
  const path = join(root, 'documentation/references', `${ref}-fixture.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\ntitle: ${ref} synthetic seed\n${fields}\n---\n# ${ref}\n`);
  return path;
}
function resetMtimes() {
  for (const record of loadCorpusIdentities(root)) utimesSync(record.path, now, now);
}

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), 'aiwg-expand-dates-'));
  repository = join(temporary, 'repository');
  root = join(repository, 'nested-corpus');
  mkdirSync(root, { recursive: true });
  git(['init', '-q']);
  vi.stubEnv('AIWG_ARTIFACTS_PATH', join(temporary, 'payload'));
  mkdirSync(join(temporary, 'payload'));
  warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(boundedExecFileSync).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(temporary, { recursive: true, force: true });
});

describe('expansion date precedence', () => {
  it('excludes REF-016 added January 24 after clone mtimes reset and keeps newer Git additions', async () => {
    seed('REF-016'); commit();
    seed('REF-017'); commit('2026-10-01T12:00:00Z');
    const before = await expandCorpus(root, temporary, options);
    resetMtimes();
    const after = await expandCorpus(root, temporary, options);
    expect(before.scoped).toBe(1);
    expect(after.processed.map(row => row.ref)).toEqual(['REF-017']);
    expect(after.scoped).toBe(before.scoped);
    expect(warning).not.toHaveBeenCalled();
  });

  it('uses mtime for one untracked REF and emits exactly one summary warning', async () => {
    seed('REF-016'); commit();
    const untracked = seed('REF-018'); resetMtimes();
    const result = await expandCorpus(root, temporary, options);
    expect(result.processed.map(row => row.ref)).toEqual(['REF-018']);
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('1 REFs used document mtime'));
    utimesSync(untracked, new Date('2026-01-01'), new Date('2026-01-01'));
    warning.mockClear();
    expect((await expandCorpus(root, temporary, options)).scoped).toBe(0);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('uses one counted warning outside Git, including files excluded by --since', async () => {
    root = join(temporary, 'outside');
    seed('REF-016'); const old = seed('REF-017'); resetMtimes();
    utimesSync(old, new Date('2026-01-01'), new Date('2026-01-01'));
    const result = await expandCorpus(root, repository, options);
    expect(result.processed.map(row => row.ref)).toEqual(['REF-016']);
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('2 REFs used document mtime'));
  });

  it('uses mtime for an untracked replacement even when its path has old Git history', async () => {
    const path = seed('REF-016'); commit();
    git(['rm', '--', path]); commit('2026-02-01T12:00:00Z');
    seed('REF-016'); resetMtimes();
    expect((await expandCorpus(root, temporary, options)).processed.map(row => row.ref)).toEqual(['REF-016']);
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('1 REFs used document mtime'));
  });

  it.each(['inducted', 'inducted_on', 'added', 'created', 'date', 'discovery'])('%s frontmatter and citation discovery dates win over Git and mtime', async field => {
    seed('REF-016', field === 'discovery' ? 'discovery:\n  date: 2026-10-01' : `${field}: 2026-10-01`);
    seed('REF-017');
    const citation = join(root, 'documentation/citations/REF-017-citations.md');
    mkdirSync(dirname(citation), { recursive: true });
    writeFileSync(citation, '---\ndiscovery:\n  date: 2026-10-02\n---\n');
    commit();
    seed('REF-018', 'inducted: 2026-01-01'); commit('2026-10-01T12:00:00Z');
    resetMtimes(); vi.mocked(boundedExecFileSync).mockClear();
    expect((await expandCorpus(root, temporary, options)).processed.map(row => row.ref)).toEqual(['REF-016', 'REF-017']);
    expect(boundedExecFileSync).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it('follows renamed documents from outside the corpus and ignores later edits', async () => {
    const original = join(repository, 'original paper.md');
    writeFileSync(original, '---\ntitle: REF-016 synthetic seed\n---\n# REF-016\n'); commit();
    const target = seed('REF-016'); renameSync(original, target); commit('2026-10-01T12:00:00Z');
    writeFileSync(target, '---\ntitle: REF-016 synthetic seed\n---\n# REF-016\nLater edit\n');
    commit('2026-10-20T12:00:00Z'); resetMtimes();
    expect((await expandCorpus(root, temporary, options)).scoped).toBe(0);
    expect(warning).not.toHaveBeenCalled();
  });

  it('batches 2,000 paths (including tabs and newlines) into three explicitly bounded Git calls', () => {
    const records: CorpusIdentityRecord[] = [];
    for (let n = 0; n < 2000; n++) {
      const path = join(root, `seed ${n}${n === 0 ? '\t\n' : ''}.md`);
      writeFileSync(path, `unique synthetic seed ${n}\n`);
      records.push({ ref: `REF-${n}`, path, fields: [], keys: new Set() });
    }
    commit(); vi.mocked(boundedExecFileSync).mockClear();
    const dates = expansionDates(root, records);
    expect([...dates.values()]).toEqual(Array(2000).fill(Date.parse('2026-01-24T12:00:00Z')));
    expect(boundedExecFileSync).toHaveBeenCalledTimes(3);
    for (const [command, , tier, controls] of vi.mocked(boundedExecFileSync).mock.calls) {
      expect(command).toBe('git'); expect(tier).toBe('quick');
      expect(controls).toMatchObject({ timeout: 30_000 });
    }
    expect(warning).not.toHaveBeenCalled();
  });

  it('falls back with a summary when the bounded Git history query fails', () => {
    const path = seed('REF-016'); commit(); resetMtimes();
    vi.mocked(boundedExecFileSync).mockImplementationOnce(() => repository)
      .mockImplementationOnce(() => 'nested-corpus/documentation/references/REF-016-fixture.md\0')
      .mockImplementationOnce(() => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); });
    expect(expansionDates(root, loadCorpusIdentities(root)).get(path)).toBe(now.getTime());
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('1 REFs used document mtime'));
  });

  it('does not query Git or warn without --since and documents the fallback order', async () => {
    seed('REF-016'); vi.mocked(boundedExecFileSync).mockClear();
    expect((await expandCorpus(root, temporary, { ...options, since: undefined })).scoped).toBe(1);
    expect(boundedExecFileSync).not.toHaveBeenCalled(); expect(warning).not.toHaveBeenCalled();
    expect(EXPAND_USAGE).toContain('then Git first-add date, then document mtime with a summary warning');
  });
});
