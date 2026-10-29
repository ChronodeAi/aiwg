// Public corpus-handler coverage using real research clients and offline HTTP fixtures.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as yieldToIO } from 'node:timers/promises';
import { corpusHandler } from '../../../src/cli/handlers/subcommands.js';
import type { ExpansionResult } from '../../../src/artifacts/corpus-tools/expand.js';
import { expansionFetch, expansionHttp, recommended, type ExpansionHttp } from '../../fixtures/research/expand-http.js';

let root: string;
let artifacts: string;
let state: ExpansionHttp;
let fetchMock: ReturnType<typeof vi.fn>;
let output: string;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
  root = mkdtempSync(join(tmpdir(), 'aiwg-expand-'));
  artifacts = join(root, 'payload');
  mkdirSync(artifacts);
  for (const key of ['S2_API_KEY', 'AIWG_CORPUS_ROOT', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) vi.stubEnv(key, '');
  vi.stubEnv('AIWG_ARTIFACTS_PATH', artifacts);
  state = expansionHttp();
  fetchMock = vi.fn(expansionFetch(state));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
});

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, content: string) {
  const file = join(root, relative);
  mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, content);
  return file;
}

function seed(ref: string, fields = 'arxiv: 2401.12345', title = `Seed ${ref}`, body = '') {
  return write(`documentation/references/${ref}-fixture.md`, `---\ntitle: ${title}\n${fields}\n---\n# ${title}\n${body}\n`);
}

const discovery = (file: string) => join(artifacts, 'research/discovery', file);
const rows = (file: string) => readFileSync(discovery(file), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

async function cli(args: string[], json = true, sub = 'expand') {
  output = '';
  const all = [sub, ...args, ...(json ? ['--json'] : [])];
  let done = false;
  const pending = corpusHandler.execute({ args: all, rawArgs: ['corpus', ...all], cwd: root, frameworkRoot: root });
  void pending.then(() => { done = true; });
  for (let turn = 0; !done && turn < 10000; turn++) {
    await yieldToIO(1); await vi.advanceTimersByTimeAsync(1000);
  }
  expect(done).toBe(true);
  const result = await pending;
  return { ...result, data: json && output ? JSON.parse(output) as ExpansionResult : undefined, output };
}

describe('corpus expand frontier and HTTP contract', () => {
  it('requires an explicit scope and makes no requests without one', async () => {
    const result = await cli([]);
    expect(result.exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('defaults to dry run and only --write persists frontier, queue, report and rejected list', async () => {
    seed('REF-0001'); state.recommendations['arXiv:2401.12345'] = [recommended('a')];
    const preview = await cli(['--all']);
    expect(preview.exitCode).toBe(0);
    expect(preview.data).toMatchObject({ dry_run: true, processed: [{ status: 'explored', n_returned: 1 }], candidates: [{ seed_refs: ['REF-0001'] }] });
    expect(existsSync(discovery('expansion-state.jsonl'))).toBe(false);
    expect(existsSync(discovery('candidates.jsonl'))).toBe(false);
    expect(existsSync(join(artifacts, 'research'))).toBe(false);
    const result = await cli(['--all', '--write']);
    expect(result.data!.dry_run).toBe(false);
    expect(rows('expansion-state.jsonl')).toHaveLength(1);
    expect(rows('candidates.jsonl')).toHaveLength(1);
    expect(readFileSync(discovery('expansion-report.md'), 'utf8')).toContain('convergence=1, recency=2024');
    expect(existsSync(discovery('rejected-candidates.jsonl'))).toBe(true);
    expect(existsSync(join(root, '.aiwg/research'))).toBe(false);
    expect(existsSync(join(root, 'documentation/citations'))).toBe(false);
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/recommendations/v1/papers/forpaper/'))).toBe(true);
  });

  it('handles both frontmatter spellings, DOI, old-style body URLs and version stripping', async () => {
    seed('REF-0001', 'arxiv: "https://arxiv.org/pdf/2401.12345v3.pdf"');
    seed('REF-0002', 'arxiv_id: 0704.0001v2');
    seed('REF-0003', 'doi: https://doi.org/10.1234/EXAMPLE');
    seed('REF-0004', '', 'Body seed', '[PDF](https://arxiv.org/pdf/hep-th/9901001v4.pdf)');
    for (const id of ['arXiv:2401.12345', 'arXiv:0704.0001', 'DOI:10.1234/example', 'arXiv:hep-th/9901001']) state.recommendations[id] = [];
    vi.stubEnv('S2_API_KEY', 'synthetic-key');
    const result = await cli(['--all', '--write', '--per-seed', '7', '--from', 'all-cs']);
    expect(result.exitCode).toBe(0); expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.data!.processed.map(row => row.seed_id)).toEqual(Object.keys(state.recommendations));
    for (const call of state.calls) {
      expect(call.headers.get('x-api-key')).toBe('synthetic-key');
      expect(call.url.searchParams.get('limit')).toBe('7');
      expect(call.url.searchParams.get('from')).toBe('all-cs');
      expect(call.url.searchParams.get('fields')).toContain('externalIds');
    }
    expect(state.calls[2].url.pathname).toBe('/recommendations/v1/papers/forpaper/DOI:10.1234%2Fexample');
    expect(state.calls[3].url.pathname).toContain('arXiv:hep-th%2F9901001');
  });

  it('makes zero API calls immediately after a full write and re-explores after the window', async () => {
    seed('REF-0001'); state.recommendations['arXiv:2401.12345'] = [recommended('a')];
    await cli(['--all', '--write']); fetchMock.mockClear();
    expect((await cli(['--all', '--write'])).data!.processed).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(181 * 86400000);
    await cli(['--all', '--write']); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rows('candidates.jsonl')[0].score_parts.convergence).toBe(1);
    expect(rows('expansion-state.jsonl')).toHaveLength(2);
  });

  it('resumes --max-seeds without repeating successful seeds and spaces unauthenticated calls', async () => {
    for (let n = 1; n <= 3; n++) { seed(`REF-000${n}`, `arxiv_id: 2401.0000${n}`); state.recommendations[`arXiv:2401.0000${n}`] = [recommended('shared')]; }
    expect((await cli(['--all', '--write', '--max-seeds', '2'])).data!.remaining).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.calls[1].time - state.calls[0].time).toBeGreaterThanOrEqual(1000);
    expect((await cli(['--all', '--write', '--max-seeds', '2'])).data!.processed.map(row => row.ref)).toEqual(['REF-0003']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(rows('candidates.jsonl')[0].score_parts.convergence).toBe(3);
    fetchMock.mockClear(); await cli(['--all', '--write', '--max-seeds', '2']); expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it.each([429, 404, 503, 'network', 'malformed'] as const)('records %s as retryable and retries next run', async failure => {
    seed('REF-0001'); state.recommendations['arXiv:2401.12345'] = failure;
    const result = await cli(['--all', '--write']);
    expect(result.exitCode).toBe(3); expect(result.data!.incomplete).toBe(true);
    expect(rows('expansion-state.jsonl')[0]).toMatchObject({ status: failure === 429 ? 'throttled' : 'not-found', n_returned: 0 });
    expect(rows('candidates.jsonl')).toEqual([]);
    for (let n = 1; n < state.calls.length; n++) expect(state.calls[n].time - state.calls[n - 1].time).toBeGreaterThanOrEqual(1000);
    fetchMock.mockClear(); state.recommendations['arXiv:2401.12345'] = [recommended('recovered')];
    expect((await cli(['--all', '--write'])).exitCode).toBe(0); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rows('expansion-state.jsonl')[1].status).toBe('explored');
  });

  it('records no-id without HTTP and picks up an ID added later', async () => {
    seed('REF-0001', '');
    expect((await cli(['--all', '--write'])).data!.processed[0].status).toBe('no-id');
    expect(fetchMock).not.toHaveBeenCalled();
    seed('REF-0001', 'arxiv: 2401.12345'); state.recommendations['arXiv:2401.12345'] = [];
    expect((await cli(['--all', '--write'])).data!.processed[0].status).toBe('explored');
  });
});

describe('corpus expand identity suppression and ranking', () => {
  it('dedups corpus arXiv/DOI pairs, S2 IDs and punctuation/case/LaTeX title variants', async () => {
    seed('REF-0001', 'arxiv: 2401.12345', 'Primary seed', 'Related work: https://arxiv.org/abs/2406.66666');
    seed('REF-0002', 'arxiv_id: 2402.22222v2', 'Existing paired work');
    write('documentation/citations/REF-0002-citations.md', '---\ndoi: https://doi.org/10.1234/PAIRED\ns2_paper_id: CORPUS-S2\n---\n');
    seed('REF-0003', '', 'Self-Supervised: REPRESENTATION Learning!');
    state.recommendations['arXiv:2401.12345'] = [
      recommended('arxiv-copy', 'Other title', 2024, { ArXiv: '2402.22222v5' }),
      recommended('doi-copy', 'Journal version title', 2024, { DOI: '10.1234/paired' }),
      recommended('CORPUS-S2', 'Another title'),
      recommended('title-copy', 'ｓｅｌｆ {supervised} representation learning'),
      recommended('new', 'New work', 2024, { ArXiv: '2406.66666' }),
    ];
    const result = await cli(['--seeds', 'REF-0001', '--write']);
    expect(result.data!.candidates.map(row => row.paper.id)).toEqual(['new']);
    expect(rows('candidates.jsonl')).toHaveLength(1);
  });

  it('merges existing queue and rejected identities while ranking convergence before recency', async () => {
    for (let n = 1; n <= 3; n++) seed(`REF-000${n}`, `arxiv: 2401.0000${n}`);
    state.recommendations['arXiv:2401.00001'] = [recommended('shared', 'Shared', 2024, { DOI: '10.1234/shared' }), recommended('single'), recommended('newer', 'Newer', 2025)];
    state.recommendations['arXiv:2401.00002'] = [recommended('shared-alias', 'SHARED!', 2024, { DOI: 'https://doi.org/10.1234/SHARED' })];
    state.recommendations['arXiv:2401.00003'] = [recommended('shared', 'Shared', 2024, { ArXiv: '2405.55555' })];
    await cli(['--all', '--write', '--max-seeds', '1']);
    let result = await cli(['--all', '--write']);
    expect(result.data!.candidates.map(row => row.paper.title)).toEqual(['Shared', 'Newer', 'Candidate single']);
    expect(result.data!.candidates[0]).toMatchObject({ seed_refs: ['REF-0001', 'REF-0002', 'REF-0003'], score_parts: { convergence: 3, recency: 2024, overlap: null },
      discovery: { surface: 's2-recommendation', via: 'S2 recommendations for REF-0001, REF-0002, REF-0003' } });
    writeFileSync(discovery('rejected-candidates.jsonl'), JSON.stringify(result.data!.candidates[0]) + '\n' + JSON.stringify({ title: 'candidate SINGLE!' }) + '\n');
    const before = readFileSync(discovery('candidates.jsonl'), 'utf8');
    result = await cli(['--all']); expect(result.data!.candidates.map(row => row.paper.id)).toEqual(['newer']);
    expect(readFileSync(discovery('candidates.jsonl'), 'utf8')).toBe(before);
    vi.advanceTimersByTime(181 * 86400000);
    state.recommendations['arXiv:2401.00002'] = [recommended('shared-alias', 'A changed title')];
    await cli(['--all', '--write']); expect(rows('candidates.jsonl').map(row => row.paper.id)).toEqual(['newer']);
  });

  it('caps overlap lookups at 20 and leaves failures retryable', async () => {
    seed('REF-0001');
    state.recommendations['arXiv:2401.12345'] = Array.from({ length: 21 }, (_, i) => recommended(String(i).padStart(2, '0')));
    for (let i = 0; i < 20; i++) state.references[String(i).padStart(2, '0')] = [];
    state.references['00'] = 404;
    let result = await cli(['--all', '--overlap', '--write', '--per-seed', '21']);
    expect(result.exitCode).toBe(3);
    expect(result.data!.overlap_errors).toEqual([{ paper_id: '00', error: expect.any(String) }]);
    expect(fetchMock).toHaveBeenCalledTimes(21);
    expect(result.data!.candidates.filter(row => row.score_parts.overlap === null)).toHaveLength(2);
    state.references['00'] = []; state.references['20'] = []; fetchMock.mockClear();
    result = await cli(['--all', '--overlap', '--write']);
    expect(result.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.calls.filter(call => call.url.pathname.endsWith('/paper/20'))).toHaveLength(0);
  });

  it('honours min-year, optional overlap, audited scores and cached zero-call repeat', async () => {
    seed('REF-0001');
    state.recommendations['arXiv:2401.12345'] = [recommended('a'), recommended('b'), recommended('old', 'Old', 2010)];
    state.references.a = []; state.references.b = [recommended('seed', 'Seed alias', 2024, { ArXiv: '2401.12345' }), recommended('seed-copy', 'Seed alias', 2024, { ArXiv: '2401.12345v2' })];
    let result = await cli(['--all', '--write']); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.data!.candidates.map(row => row.paper.id)).toEqual(['a', 'b']);
    result = await cli(['--all', '--overlap', '--write']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.data!.candidates.map(row => row.paper.id)).toEqual(['b', 'a']);
    expect(result.data!.candidates[0].score_parts.overlap).toBe(1);
    fetchMock.mockClear(); await cli(['--all', '--overlap', '--write']); expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

describe('corpus expand scope, errors and provenance CLI', () => {
  it('selects --since from frontmatter, discovery date and document mtime', async () => {
    seed('REF-0001', 'arxiv: 2401.00001\ninducted: 2026-09-01');
    seed('REF-0002', 'arxiv: 2401.00002');
    write('documentation/citations/REF-0002-citations.md', '---\ndiscovery:\n  date: 2026-10-15\n---\n');
    const file = seed('REF-0003', 'arxiv: 2401.00003'); utimesSync(file, new Date('2026-10-20'), new Date('2026-10-20'));
    state.recommendations['arXiv:2401.00002'] = []; state.recommendations['arXiv:2401.00003'] = [];
    expect((await cli(['--since', '2026-10-01'])).data!.processed.map(row => row.ref)).toEqual(['REF-0002', 'REF-0003']);
  });

  it('rejects invalid controls before HTTP or writes with usage exit 1', async () => {
    for (const args of [['--all', '--seeds', 'REF-0001'], ['--since', '2026-02-30'], ['--since'], ['--seeds', 'bad'], ['--seeds', 'REF-9999'], ['--max-seeds', '0'], ['--max-seeds', '-1'], ['--per-seed', '501'], ['--from', 'invalid'], ['--min-year', 'bad'], ['--reexplore-after', '0d'], ['--reexplore-after', '2h'], ['--write', '--write'], ['--unknown'], ['extra']]) {
      expect((await cli(args)).exitCode, args.join(' ')).toBe(1);
    }
    expect(fetchMock).not.toHaveBeenCalled(); expect(existsSync(join(artifacts, 'research'))).toBe(false);
  });

  it('honours .aiwg-location independently of corpus root and fails for an unavailable external root', async () => {
    vi.stubEnv('AIWG_ARTIFACTS_PATH', ''); write('.aiwg-location', artifacts);
    vi.stubEnv('AIWG_CORPUS_ROOT', join(root, 'other-corpus'));
    write('other-corpus/documentation/references/REF-0001-fixture.md', '---\ntitle: External seed\narxiv: 2401.12345\n---\n');
    state.recommendations['arXiv:2401.12345'] = [];
    expect((await cli(['--all', '--write'])).exitCode).toBe(0); expect(rows('expansion-state.jsonl')).toHaveLength(1);
    write('.aiwg-location', join(root, 'missing')); fetchMock.mockClear();
    expect((await cli(['--all', '--write'])).exitCode).toBe(1); expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(root, '.aiwg/research'))).toBe(false);
  });

  it('accepts s2-recommendation through discovery-log and exposes expansion help', async () => {
    write('documentation/citations/REF-0001-citations.md', '---\nref: REF-0001\n---\n# Citation\n');
    const result = await cli(['--ref', 'REF-0001', '--surface', 's2-recommendation', '--via', 'S2 recommendations for REF-0002', '--write'], false, 'discovery-log');
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, 'documentation/citations/REF-0001-citations.md'), 'utf8')).toContain('surface: s2-recommendation');
    expect((await cli(['--help'], false)).output).toContain('--max-seeds');
    expect((await cli([], false, '--help')).output).toContain('aiwg corpus expand');
  });
});
