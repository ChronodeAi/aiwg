// Exercise persisted review and frontier safeguards through the public corpus handler with fake HTTP.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { corpusHandler } from '../../../src/cli/handlers/subcommands.js';
import { expansionFetch, expansionHttp, recommended, type ExpansionHttp } from '../../fixtures/research/expand-http.js';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, writeFileSync: vi.fn(fs.writeFileSync) };
});

let root: string;
let artifacts: string;
let http: ExpansionHttp;
let fetchMock: ReturnType<typeof vi.fn>;
let output: string;

beforeEach(async () => {
  await import('../../../src/artifacts/corpus-tools/cli.js');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
  root = mkdtempSync(join(tmpdir(), 'aiwg-review-'));
  artifacts = join(root, 'payload'); mkdirSync(artifacts);
  for (const key of ['S2_API_KEY', 'AIWG_CORPUS_ROOT', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) vi.stubEnv(key, '');
  vi.stubEnv('AIWG_ARTIFACTS_PATH', artifacts);
  http = expansionHttp(); fetchMock = vi.fn(expansionFetch(http)); vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
});

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

const file = (name: string) => join(artifacts, 'research/discovery', name);
const rows = (name = 'candidates.jsonl') => readFileSync(file(name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
function write(path: string, content: string) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content); }
function seed(ref = 'REF-0001', id = '2401.12345') {
  write(join(root, `documentation/references/${ref}-fixture.md`), `---\ntitle: Seed ${ref}\narxiv: ${id}\n---\n`);
}
async function cli(args: string[], sub = 'review', json = true) {
  output = '';
  const all = [sub, ...args, ...(json ? ['--json'] : [])];
  let done = false;
  const pending = corpusHandler.execute({ args: all, rawArgs: ['corpus', ...all], cwd: root, frameworkRoot: root });
  void pending.then(() => { done = true; });
  for (let turn = 0; !done && turn < 10000; turn++) { await yieldToIO(); await vi.advanceTimersByTimeAsync(1000); }
  expect(done).toBe(true);
  const result = await pending;
  return { ...result, data: json && output ? JSON.parse(output) : undefined, output };
}
async function populate() {
  seed();
  http.recommendations['arXiv:2401.12345'] = [recommended('a', 'First candidate', 2024, { DOI: '10.1234/first', ArXiv: '2405.55555' }), recommended('b')];
  expect((await cli(['--all', '--write'], 'expand')).exitCode).toBe(0);
  fetchMock.mockClear();
}

describe('candidate review CLI', () => {
  it('lists scores and statuses without HTTP or writes, including an empty queue and JSON help', async () => {
    expect((await cli([])).data.candidates).toEqual([]);
    expect(existsSync(file('candidates.jsonl'))).toBe(false);
    await populate();
    const before = readFileSync(file('candidates.jsonl'), 'utf8');
    expect((await cli(['list'])).data.candidates[0]).toMatchObject({ score_parts: { convergence: 1, recency: 2024, overlap: null } });
    expect((await cli([], 'review', false)).output).toContain('Score components: convergence=1, recency=2024');
    expect((await cli(['--help'])).data.usage).toContain('review accept <id>');
    expect((await cli([], '--help', false)).output).toContain('aiwg corpus review');
    expect(readFileSync(file('candidates.jsonl'), 'utf8')).toBe(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['accept', 'reject', 'defer'])('previews %s and changes only the selected row with --write', async action => {
    await populate();
    const before = rows();
    const ledger = readFileSync(file('expansion-state.jsonl'), 'utf8');
    const rejection = readFileSync(file('rejected-candidates.jsonl'), 'utf8');
    const report = readFileSync(file('expansion-report.md'), 'utf8');
    const args = [action, 'a', ...(action === 'reject' ? ['--reason', 'Outside scope'] : [])];
    const preview = await cli(args);
    expect(preview.data).toMatchObject({ dry_run: true, change: { before: before[0], after: { review: { status: action === 'accept' ? 'accepted' : action === 'defer' ? 'deferred' : 'rejected' } } } });
    expect(rows()).toEqual(before);
    expect(readFileSync(file('expansion-state.jsonl'), 'utf8')).toBe(ledger);
    expect(readFileSync(file('rejected-candidates.jsonl'), 'utf8')).toBe(rejection);
    expect(readFileSync(file('expansion-report.md'), 'utf8')).toBe(report);
    const result = await cli([...args, '--write']);
    expect(result.exitCode).toBe(0); expect(result.data.dry_run).toBe(false);
    expect(rows().find(row => row.paper.id === 'b')).toEqual(before[1]);
    expect(readFileSync(file('expansion-state.jsonl'), 'utf8')).toBe(ledger);
    if (action === 'reject') {
      expect(rows().map(row => row.paper.id)).toEqual(['b']);
      expect(rows('rejected-candidates.jsonl')[0]).toMatchObject({ ...before[0], review: { status: 'rejected', reason: 'Outside scope' } });
    } else {
      expect(rows()[0]).toEqual(result.data.change.after);
      expect(readFileSync(file('rejected-candidates.jsonl'), 'utf8')).toBe(rejection);
    }
    expect(result.data).not.toHaveProperty('brief');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'documentation/citations'))).toBe(false);
  });

  it('finds any stored identity alias after merges and preserves reviews across re-expansion', async () => {
    await populate();
    seed('REF-0002', '2402.22222');
    http.recommendations['arXiv:2402.22222'] = [recommended('alias', 'Changed title', 2024, { DOI: '10.1234/first' })];
    await cli(['--all', '--write'], 'expand');
    for (const id of ['a', 'alias', 's2PaperId:a', 'doi:10.1234/first', 'https://doi.org/10.1234/FIRST', '2405.55555', 'arxivId:2405.55555', 'https://arxiv.org/abs/2405.55555v3']) {
      expect((await cli(['accept', id])).data.change.after.paper.id, id).toBe('alias');
    }
    await cli(['accept', 'a', '--write']); await cli(['defer', 'b', '--write']);
    const reviews = rows().map(row => row.review);
    vi.advanceTimersByTime(181 * 86400000);
    await cli(['--all', '--write'], 'expand');
    expect(rows().map(row => row.review)).toEqual(reviews);
  });

  it('keeps rejection aliases suppressed after a fresh frontier expansion', async () => {
    await populate();
    seed('REF-0002', '2402.22222');
    http.recommendations['arXiv:2402.22222'] = [recommended('alias', 'Changed title', 2024, { DOI: '10.1234/first' })];
    await cli(['--all', '--write'], 'expand');
    await cli(['reject', 'a', '--write']);
    // Fresh frontier and queue: the rejected list alone must suppress the merged S2 alias.
    writeFileSync(file('expansion-state.jsonl'), ''); writeFileSync(file('candidates.jsonl'), '');
    http.recommendations['arXiv:2401.12345'] = [recommended('a', 'Another title'), recommended('alias', 'Unrelated title'), recommended('b')];
    const result = await cli(['--all', '--write'], 'expand');
    expect(result.exitCode).toBe(0);
    expect(result.data.candidates.map((row: any) => row.paper.id)).toEqual(['b']);
    expect(rows('rejected-candidates.jsonl')).toHaveLength(1);
  });

  it('emits a complete induction brief only on accept --brief, without HTTP or induction', async () => {
    await populate();
    const before = rows();
    expect((await cli(['accept', 'a'])).data).not.toHaveProperty('brief');
    for (const persist of [false, true]) {
      const result = await cli(['accept', 'a', '--brief', ...(persist ? ['--write'] : [])]);
      for (const text of ['induct-research', 'First candidate', 's2PaperId:a', 'doi:10.1234/first', 'arxivId:2405.55555', 'REF-0001', 'convergence=1', 'recency=2024', 'overlap=not checked']) expect(result.data.brief).toContain(text);
      if (!persist) expect(rows()).toEqual(before);
    }
    expect((await cli(['accept', 'a', '--brief'], 'review', false)).output).toContain('# Induction brief for induct-research');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'documentation/citations'))).toBe(false);
    expect(rows('rejected-candidates.jsonl')).toEqual([]);
  });

  it('rejects invalid actions and ambiguous IDs with the standard usage envelope before writes', async () => {
    await populate();
    const before = readFileSync(file('candidates.jsonl'), 'utf8');
    for (const args of [['accept'], ['reject'], ['defer'], ['accept', 'missing'], ['list', 'a'], ['list', '--write'], ['list', '--brief'], ['defer', 'a', '--reason', 'x'], ['reject', 'a', '--brief'], ['reject', 'a', '--reason'], ['reject', 'a', '--reason', ' '], ['accept', 'a', '--write', '--write'], ['unknown'], ['--unknown'], ['accept', 'a', 'b']]) {
      const result = await cli(args);
      expect(result.exitCode, args.join(' ')).toBe(1);
      expect(result.data).toMatchObject({ error: { code: 'ERR_CORPUS_REVIEW_USAGE', message: expect.any(String), hint: expect.stringContaining('aiwg corpus review') }, exitCode: 1 });
    }
    expect(readFileSync(file('candidates.jsonl'), 'utf8')).toBe(before);
    const ambiguous = rows(); ambiguous[1].identity_keys.push('doi:10.1234/first');
    writeFileSync(file('candidates.jsonl'), ambiguous.map(row => JSON.stringify(row)).join('\n'));
    expect((await cli(['accept', 'doi:10.1234/first', '--write'])).data.error.message).toContain('Ambiguous');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['candidates.jsonl', 'rejected-candidates.jsonl', 'expansion-state.jsonl'])('refuses damaged %s without changing any file', async damaged => {
    await populate(); writeFileSync(file(damaged), readFileSync(file(damaged), 'utf8') + '{"torn":');
    const names = ['candidates.jsonl', 'rejected-candidates.jsonl', 'expansion-state.jsonl', 'expansion-report.md'];
    const before = names.map(name => readFileSync(file(name), 'utf8'));
    expect((await cli(['reject', 'a', '--write'])).data).toMatchObject({ error: { code: 'ERR_CORPUS_COMMAND' }, exitCode: 1 });
    expect(names.map(name => readFileSync(file(name), 'utf8'))).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the configured external artifact root and refuses an unavailable root', async () => {
    await populate();
    vi.stubEnv('AIWG_ARTIFACTS_PATH', ''); write(join(root, '.aiwg-location'), artifacts);
    expect((await cli(['accept', 'a', '--write'])).exitCode).toBe(0);
    expect(rows()[0].review.status).toBe('accepted');
    expect(existsSync(join(root, '.aiwg'))).toBe(false);
    write(join(root, '.aiwg-location'), join(root, 'missing'));
    expect((await cli(['accept', 'a', '--write'])).data.exitCode).toBe(1);
    expect(existsSync(join(root, '.aiwg'))).toBe(false);
  });

  it('persists suppression before a torn queue replacement and recovers through expand', async () => {
    await populate();
    const before = readFileSync(file('candidates.jsonl'), 'utf8');
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(writeFileSync).mockImplementation((path, content, options) => {
      if (String(path).startsWith(file('candidates.jsonl') + '.')) { fs.writeFileSync(path, '{"torn":', options); throw new Error('Injected queue failure'); }
      fs.writeFileSync(path, content, options);
    });
    expect((await cli(['reject', 'a', '--write'])).exitCode).toBe(1);
    expect(rows('rejected-candidates.jsonl')[0].paper.id).toBe('a');
    expect(readFileSync(file('candidates.jsonl'), 'utf8')).toBe(before);
    vi.mocked(writeFileSync).mockImplementation(fs.writeFileSync);
    expect((await cli(['--all', '--write'], 'expand')).data.candidates.map((row: any) => row.paper.id)).toEqual(['b']);
  });
});

describe('frontier review minors', () => {
  it('compacts on a no-due write and preserves every REF latest status, including out-of-scope seeds', async () => {
    await populate();
    const original = rows('expansion-state.jsonl')[0];
    const latest = ['explored', 'throttled', 'not-found', 'no-id'].map((status, i) => ({ ...original, ref: `REF-000${i + 1}`, seed_id: i === 3 ? null : original.seed_id, status }));
    const historical = latest.map(row => ({ ...row, status: 'explored', explored_on: '2020-01-01' }));
    const content = [...historical, ...latest].map(row => JSON.stringify(row)).join('\n') + '\n';
    writeFileSync(file('expansion-state.jsonl'), content);
    await cli(['--seeds', 'REF-0001'], 'expand');
    expect(readFileSync(file('expansion-state.jsonl'), 'utf8')).toBe(content);
    await cli(['--seeds', 'REF-0001', '--write'], 'expand');
    expect(rows('expansion-state.jsonl')).toEqual(latest);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the ledger intact if compaction tears and retries without losing statuses', async () => {
    await populate();
    const before = readFileSync(file('expansion-state.jsonl'), 'utf8');
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(writeFileSync).mockImplementation((path, content, options) => {
      if (String(path).includes('expansion-state.jsonl.')) { fs.writeFileSync(path, '{"torn":', options); throw new Error('Injected compaction failure'); }
      fs.writeFileSync(path, content, options);
    });
    expect((await cli(['--all', '--write'], 'expand')).exitCode).toBe(1);
    expect(readFileSync(file('expansion-state.jsonl'), 'utf8')).toBe(before);
    vi.mocked(writeFileSync).mockImplementation(fs.writeFileSync);
    expect((await cli(['--all', '--write'], 'expand')).exitCode).toBe(0);
    expect(readFileSync(file('expansion-state.jsonl'), 'utf8')).toBe(before);
  });

  it('warns once per conflicting REF, prefers primary IDs, and ignores normalized aliases', async () => {
    seed(); seed('REF-0002', '2402.22222');
    write(join(root, 'documentation/citations/REF-0001-citations.md'), '---\narxiv_id: 2403.33333\ndoi: 10.1234/conflict\n---\n');
    write(join(root, 'documentation/citations/REF-0002-citations.md'), '---\narxiv_id: https://arxiv.org/abs/2402.22222v3\n---\n');
    http.recommendations['arXiv:2401.12345'] = []; http.recommendations['arXiv:2402.22222'] = [];
    const warnings: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { warnings.push(String(chunk)); return true; });
    expect((await cli(['--all', '--write'], 'expand')).exitCode).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('REF-0001 primary and sidecar seed IDs differ');
    expect(rows('expansion-state.jsonl').map(row => row.seed_id)).toEqual(['arXiv:2401.12345', 'arXiv:2402.22222']);
  });
});
