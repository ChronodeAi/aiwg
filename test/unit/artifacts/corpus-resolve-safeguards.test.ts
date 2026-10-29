// Exercise retryable outcomes, paced batches, conservative titles and canonical metadata offline.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveReference, type ResolutionResult } from '../../../src/artifacts/corpus-tools/resolve.js';
import { resolveCli, RESOLVE_USAGE } from '../../../src/artifacts/corpus-tools/resolve-cli.js';
import { fixtureFetch, httpFixture, s2Paper, crossrefPaper, type HttpFixture } from '../../fixtures/research/resolve-http.js';

let root: string;
let state: HttpFixture;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('S2_API_KEY', '');
  root = mkdtempSync(join(tmpdir(), 'aiwg-resolve-safeguards-'));
  state = httpFixture();
  fetchMock = vi.fn(fixtureFetch(state));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});
async function run(input: string) {
  const result = resolveReference(input, root);
  await vi.runAllTimersAsync();
  return result;
}

describe('retryable resolution', () => {
  it.each([429, 503])('defers an unsuccessful lookup after source error %s', async status => {
    state.errors = { s2: status, arxiv: status };
    const result = await run('Hamiltonian Generative Networks');
    expect(result).toMatchObject({ status: 'deferred', incomplete: true, candidates: [] });
    expect(result.paths_tried.map(path => path.status)).toEqual(['error', 'error', 'empty']);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('arxiv'))).toHaveLength(4);
  });
  it('defers when every attempted source throttles, including explicit IDs', async () => {
    state.errors = { s2: 429, arxiv: 429, crossref: 429 };
    expect((await run('2401.12345')).status).toBe('deferred');
    expect((await run('A long and distinctive title here')).status).toBe('deferred');
  });
  it('keeps a plausible incomplete match ambiguous and an empty complete lookup unresolved', async () => {
    state.errors.s2 = 429;
    state.crossref = [crossrefPaper({ title: ['Hamiltonian Generative Networks Models'] })];
    expect((await run('Hamiltonian Generative Networks')).status).toBe('ambiguous');
    state.errors = {}; state.s2 = []; state.crossref = [];
    expect((await run('Hamiltonian Generative Networks')).status).toBe('unresolved');
  });
  it('documents exit 4 and chooses it as the worst batch line while continuing', async () => {
    expect(RESOLVE_USAGE).toMatch(/4 deferred.*retry/i);
    writeFileSync(join(root, 'refs.txt'), 'Self-supervised representation learning\nretry this lookup\nunrelated tokens');
    const base = fixtureFetch(state);
    fetchMock.mockImplementation(async input => String(input).includes('retry')
      ? new Response('', { status: 429 }) : base(input));
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
    const check = expect(resolveCli(['--from-file', 'refs.txt', '--json'], root, root)).rejects.toMatchObject({ exitCode: 4 });
    await vi.runAllTimersAsync(); await check;
    const results = JSON.parse(output) as ResolutionResult[];
    expect(results.map(item => item.status)).toEqual(['resolved', 'deferred', 'unresolved']);
  });
  it('paces a 113-line batch and respects Retry-After on both S2 and arXiv', async () => {
    writeFileSync(join(root, 'refs.txt'), Array(113).fill('Self-supervised representation learning').join('\n'));
    const times = { s2: [] as number[], arxiv: [] as number[] };
    const base = fixtureFetch(state);
    let throttles = 0;
    fetchMock.mockImplementation(async input => {
      const url = String(input);
      const source = url.includes('arxiv') ? 'arxiv' : url.includes('semanticscholar') ? 's2' : undefined;
      if (source) {
        times[source].push(Date.now());
        if (times[source].length === 1) { throttles++; return new Response('', { status: 429, headers: { 'Retry-After': '8' } }); }
      }
      return base(input);
    });
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
    const pending = expect(resolveCli(['--from-file', 'refs.txt', '--json'], root, root)).resolves.toBeUndefined();
    await vi.runAllTimersAsync(); await pending;
    expect(JSON.parse(output)).toHaveLength(113);
    expect(JSON.parse(output).every((item: ResolutionResult) => item.status === 'resolved')).toBe(true);
    expect(throttles).toBe(2);
    for (const source of ['s2', 'arxiv'] as const) {
      expect(times[source]).toHaveLength(114);
      expect(times[source][1] - times[source][0]).toBeGreaterThanOrEqual(8000);
      for (let i = 2; i < times[source].length; i++) {
        expect(times[source][i] - times[source][i - 1]).toBeGreaterThanOrEqual(source === 'arxiv' ? 3000 : 1000);
      }
    }
  });
});

describe('conservative title resolution', () => {
  it.each(['Deep Learning', 'Scaling Laws', 'Theory of Ordinary Differential Equations', 'Distinctive four word title'])('caps incomplete %s at ambiguous', async title => {
    state.errors.s2 = 503;
    state.crossref = [crossrefPaper({ title: [title] })];
    const result = await run(title);
    expect(result).toMatchObject({ status: 'ambiguous', incomplete: true });
    expect(result).not.toHaveProperty('paper');
  });
  it('asks for metadata for an unqualified generic title even with all sources available', async () => {
    state.s2 = [s2Paper({ title: 'Deep Learning' })];
    expect((await run('Deep Learning')).status).toBe('ambiguous');
    expect((await run('"Deep Learning" (2024)')).status).toBe('resolved');
  });
  it('permits a verified ID to resolve a short incomplete title', async () => {
    state.errors.s2 = 503; state.idTitle = 'Deep Learning';
    expect((await run('"Deep Learning" arXiv:2401.12345')).status).toBe('resolved');
  });
  it('retains ID verification when published metadata changes the primary record', async () => {
    state.idTitle = 'Deep Learning';
    const base = fixtureFetch(state);
    fetchMock.mockImplementation(async input => String(input).includes('semanticscholar')
      ? Response.json(s2Paper({ title: 'Deep Learning', externalIds: { ArXiv: '2401.12345', DOI: '10.1234/published' } }))
      : base(input));
    const result = await run('"Deep Learning" arXiv:2401.12345');
    expect(result.status).toBe('resolved');
    expect(result.paper).toMatchObject({ id: 'a'.repeat(40), arxivId: '2401.12345', doi: '10.1234/published' });
    expect(result.candidates[0].score_parts.identifier).toBe(1);
  });
  it('caps incomplete repeated exact titles despite a year separating the scores', async () => {
    const title = 'A distinctive long title shared by different works';
    state.errors.arxiv = 503;
    state.s2 = [s2Paper({ title }), s2Paper({ title, paperId: 'b'.repeat(40), externalIds: {}, year: 2023 })];
    expect((await run(`"${title}" (2024)`)).status).toBe('ambiguous');
  });
  it('reports title mismatches for the selected candidate only', async () => {
    state.s2.push(s2Paper({ title: 'Other mismatched candidate title', paperId: 'b'.repeat(40), externalIds: {} }));
    expect((await run('Self-supervised representation learning')).findings).toEqual([]);
  });
  it('recovers a missing year from a known publication date and rejects unknown years', async () => {
    state.s2 = [s2Paper({ year: 0 })];
    expect((await run('Self-supervised representation learning')).paper?.year).toBe(2024);
    state.s2 = [s2Paper({ year: 0, publicationDate: undefined })];
    const result = await run('Self-supervised representation learning');
    expect(result.status).toBe('deferred');
    expect(result.paths_tried[0]).toMatchObject({ status: 'error' });
    expect(result).not.toHaveProperty('paper');
  });
  it('resolves VAD as one published work with its arXiv alternate ID', async () => {
    const title = 'VAD: Vectorized Scene Representation for Efficient Autonomous Driving';
    state.s2 = [s2Paper({ title, year: 2023, externalIds: { ArXiv: '2303.12077', DOI: '10.1109/iccv51070.2023.00766' } })];
    state.arxiv = [{ id: '2303.12077', title }];
    state.crossref = [crossrefPaper({ title: [title], DOI: '10.1109/iccv51070.2023.00766', type: 'proceedings-article' })];
    const result = await run(title);
    expect(result.status).toBe('resolved');
    expect(result.candidates).toHaveLength(1);
    expect(result.paper).toMatchObject({ source: 'crossref', type: 'conference', doi: '10.1109/iccv51070.2023.00766', arxivId: '2303.12077' });
  });
});
