// Exercise aiwg corpus dispatch, real clients and corpus readers with offline HTTP fixtures.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as yieldToIO } from 'node:timers/promises';
import { corpusHandler } from '../../../src/cli/handlers/subcommands.js';
import type { ResolutionResult } from '../../../src/artifacts/corpus-tools/resolve.js';
import { fixtureFetch, httpFixture, s2Paper, crossrefPaper, type HttpFixture } from '../../fixtures/research/resolve-http.js';

let root: string;
let state: HttpFixture;
let fetchMock: ReturnType<typeof vi.fn>;
let output: string;
const title = 'Self-supervised representation learning';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubEnv('S2_API_KEY', '');
  vi.stubEnv('AIWG_CORPUS_ROOT', '');
  root = mkdtempSync(join(tmpdir(), 'aiwg-resolve-'));
  state = httpFixture();
  fetchMock = vi.fn(fixtureFetch(state));
  vi.stubGlobal('fetch', fetchMock);
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

async function cli(args: string[], json = true) {
  output = '';
  const allArgs = ['resolve', ...args, ...(json ? ['--json'] : [])];
  let done = false;
  const pending = corpusHandler.execute({ args: allArgs, rawArgs: ['corpus', ...allArgs], cwd: root, frameworkRoot: root });
  void pending.then(() => { done = true; });
  // Yield to config/file IO, then advance rate-limit and retry timers without wall-clock waits.
  for (let turn = 0; !done && turn < 10000; turn++) {
    await yieldToIO(1);
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(done).toBe(true);
  const result = await pending;
  return { ...result, data: json && output ? JSON.parse(output) as ResolutionResult : undefined, output };
}

function write(relative: string, content: string): void {
  const file = join(root, relative);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

describe('aiwg corpus resolve identifiers', () => {
  it.each([
    ['2401.12345', 'arxiv', '2401.12345', undefined],
    ['0704.0001', 'arxiv', '0704.0001', undefined],
    ['arXiv:0704.0001v2', 'arxiv', '0704.0001', 2],
    ['hep-th/9901001', 'arxiv', 'hep-th/9901001', undefined],
    ['hep-th/9901001v3', 'arxiv', 'hep-th/9901001', 3],
    ['https://arxiv.org/abs/2401.12345v2', 'arxiv', '2401.12345', 2],
    ['https://arxiv.org/pdf/0704.0001.pdf', 'arxiv', '0704.0001', undefined],
    ['https://arxiv.org/html/2401.12345v2', 'arxiv', '2401.12345', 2],
    ['https://arxiv.org/pdf/hep-th/9901001v3.pdf', 'arxiv', 'hep-th/9901001', 3],
    ['10.48550/arXiv.2401.12345v2', 'arxiv', '2401.12345', 2],
    ['https://doi.org/10.48550/arXiv.0704.0001', 'arxiv', '0704.0001', undefined],
    ['10.1234/FIXTURE', 'doi', '10.1234/fixture', undefined],
    ['https://doi.org/10.1234/FIXTURE', 'doi', '10.1234/fixture', undefined],
    ['http://dx.doi.org/10.1234/FIXTURE', 'doi', '10.1234/fixture', undefined],
    ['https://openreview.net/forum?id=AbC-123', 'openreview', 'AbC-123', undefined],
    ['https://openreview.net/pdf?id=AbC-123', 'openreview', 'AbC-123', undefined],
    ['OpenReview:AbC-123', 'openreview', 'AbC-123', undefined],
    ['https://aclanthology.org/2024.acl-long.1/', 'acl', '2024.acl-long.1', undefined],
    ['https://aclanthology.org/P19-1010.pdf', 'acl', 'P19-1010', undefined],
    ['2024.acl-long.1', 'acl', '2024.acl-long.1', undefined],
    ['P19-1010', 'acl', 'P19-1010', undefined],
    ['ACL:P19-1010', 'acl', 'P19-1010', undefined],
    ['SemanticScholar:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 's2', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', undefined],
    ['S2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 's2', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', undefined],
    ['https://www.semanticscholar.org/paper/Example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 's2', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', undefined],
    ['https://semanticscholar.org/paper/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 's2', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', undefined],
    ['CorpusId:12345', 's2', 'CorpusId:12345', undefined],
    ['S2:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 's2', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', undefined, true],
  ])('verifies %s through the public handler', async (input, kind, id, version, wrongId) => {
    if (wrongId) fetchMock.mockResolvedValue(Response.json(s2Paper()));
    const result = await cli([input as string]);
    if (wrongId) {
      expect(result.exitCode).toBe(3);
      expect(result.data!.candidates).toEqual([]);
      expect(result.data!.findings).toContainEqual({ type: 'identifier_mismatch', supplied: id,
        returned: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', candidate: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
      return;
    }
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({ status: 'resolved', input, reference: { identifier: { kind, id } }, incomplete: false });
    expect(result.data!.paths_tried.length).toBeGreaterThan(0);
    expect(result.data!.paths_tried.every(path => path.method === 'id' && path.status === 'returned')).toBe(true);
    expect(result.data!.candidates).toHaveLength(1);
    if (kind === 'arxiv') {
      expect(result.data!.paper).toMatchObject({ arxivId: id, arxivVersion: 4 });
      if (version) expect(result.data!.reference.identifier!.version).toBe(version);
    }
    if (kind === 'doi') expect(result.data!.paper!.doi).toBe(id);
    if (kind === 'openreview') expect(result.data!.paper!.openReviewId).toBe(id);
    if (kind === 'acl') expect(result.data!.paper!.aclId).toBe(id);
    const s2url = new URL(fetchMock.mock.calls.find(([url]) => String(url).includes('semanticscholar'))![0]);
    expect(s2url.pathname).toContain('/graph/v1/paper/');
    expect(s2url.searchParams.get('fields')).toContain('publicationVenue');
    expect(s2url.searchParams.get('fields')).toContain('publicationDate');
  });
});

describe('aiwg corpus resolve title matching and findings', () => {
  it.each(['error', 'empty', 'mismatch'])('caps a title match after an explicit ACL lookup returns %s', async mode => {
    const fetchFixture = fixtureFetch(state);
    fetchMock.mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname.includes('/paper/ACL:')) {
        if (mode === 'mismatch') return Response.json(s2Paper({ externalIds: { ACL: 'P19-9999' } }));
        return new Response('', { status: mode === 'error' ? 503 : 404 });
      }
      return fetchFixture(input);
    });
    const input = '"Attention Is All You Need". ACL:P19-1010';
    state.s2 = [s2Paper({ title: 'Attention Is All You Need' })];
    const result = await cli([input]);
    expect(result.exitCode).toBe(2);
    expect(result.data).toMatchObject({ status: 'ambiguous', incomplete: mode === 'error' });
    expect(result.data).not.toHaveProperty('paper');
    expect(result.data!.candidates[0].score).toBe(1);
    const idPaths = result.data!.paths_tried.filter(path => path.method === 'id');
    expect(idPaths).toHaveLength(1);
    expect(idPaths[0].status).toBe(mode === 'mismatch' ? 'returned' : mode);
    expect(result.data!.findings).toContainEqual(expect.objectContaining({ type: 'identifier_unresolved', supplied: 'P19-1010', paths: idPaths }));
    const finding = result.data!.findings.find(item => item.type === 'identifier_unresolved')!;
    expect(finding.returned).toContain(`semantic-scholar/id (ACL:P19-1010): ${mode === 'mismatch' ? 'returned (identifier mismatch)' : mode}`);
    if (mode === 'mismatch') expect(finding.returned).toContain('P19-9999');
  });

  it('reports every failed ID path even when no title candidate is found', async () => {
    state.errors = { crossref: 404, s2: 503 };
    const result = await cli(['10.1234/missing']);
    expect(result.exitCode).toBe(4);
    expect(result.data!.status).toBe('deferred');
    expect(result.data!.findings).toContainEqual(expect.objectContaining({ type: 'identifier_unresolved', supplied: '10.1234/missing',
      paths: [expect.objectContaining({ source: 'crossref', status: 'empty' }), expect.objectContaining({ source: 'semantic-scholar', status: 'error' })] }));
  });

  it('normalizes hyphens and operators in arXiv ti queries and returns canonical S2 metadata', async () => {
    const result = await cli([title]);
    expect(result.exitCode).toBe(0);
    expect(result.data!.paper).toMatchObject({ title, authors: [{ name: 'Ada Example' }], year: 2024,
      publicationDate: '2024-02-03', publicationVenue: { name: 'Synthetic Conference' },
      arxivId: '2401.12345', doi: '10.1234/fixture', s2PaperId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pdfUrl: 'https://fixture.invalid/open.pdf' });
    expect(result.data!.paths_tried.map(path => path.method)).toEqual(['title-match', 'title', 'bibliographic']);
    const arxiv = new URL(fetchMock.mock.calls[1][0]);
    expect(arxiv.searchParams.get('search_query')).toBe('ti:"self supervised representation learning"');
    expect(new URL(fetchMock.mock.calls[2][0]).searchParams.get('query.bibliographic')).toBe(title);
    expect(result.data!.findings).toEqual([]);
  });

  it('retains distinct same-title identities across sources and never picks one', async () => {
    state.s2 = [s2Paper({ externalIds: {} })];
    state.crossref = [crossrefPaper({ DOI: '10.1234/other', published: { 'date-parts': [[2023]] } })];
    // Different DOI records sharing a title are also retained.
    state.s2[0].externalIds = { DOI: '10.1234/first' };
    const result = await cli([title]);
    expect(result.exitCode).toBe(2);
    expect(result.data!.status).toBe('ambiguous');
    expect(result.data!.candidates).toHaveLength(2);
    expect(result.data).not.toHaveProperty('paper');
  });

  it('keeps an S2 record without externalIds separate from a same-title CrossRef DOI', async () => {
    state.s2 = [s2Paper({ externalIds: {} })];
    state.crossref = [crossrefPaper({ DOI: '10.1234/other' })];
    const result = await cli([title]);
    expect(result.exitCode).toBe(2);
    expect(result.data!.status).toBe('ambiguous');
    expect(result.data!.candidates).toHaveLength(2);
    expect(result.data!.candidates.map(candidate => candidate.score)).toEqual([1, 1]);
    expect(result.data).not.toHaveProperty('paper');
  });

  it('preserves title years in CLI queries while honoring --year', async () => {
    const input = 'ImageNet 2021 challenge';
    state.s2 = [s2Paper({ title: input })];
    const withoutYear = await cli([input]);
    expect(withoutYear.exitCode).toBe(0);
    expect(withoutYear.data!.reference).toMatchObject({ title: input });
    expect(withoutYear.data!.reference.year).toBeUndefined();
    expect(withoutYear.data!.candidates[0].score_parts).toEqual({ title: 1 });
    const explicitYear = await cli([input, '--year', '2024']);
    expect(explicitYear.exitCode).toBe(0);
    expect(explicitYear.data!.reference).toMatchObject({ title: input, year: 2024 });
    expect(explicitYear.data!.candidates[0].score_parts).toEqual({ title: 1, year: 1 });
  });

  it('reports near-miss titles as findings and preserves the original reference', async () => {
    state.s2 = [s2Paper({ title: 'Self-supervised representation learning models' })];
    const result = await cli([title]);
    expect(result.exitCode).toBe(2);
    expect(result.data).toMatchObject({ input: title, reference: { title }, findings: [{ type: 'title_mismatch', supplied: title, returned: state.s2[0].title }] });
    expect(result.data).not.toHaveProperty('paper');
  });

  it('uses supplied bibliography year and first author in the score', async () => {
    state.s2 = [s2Paper(), s2Paper({ paperId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', year: 2023, authors: [{ name: 'Other Person' }], externalIds: {} })];
    const input = `Example, A. (2024). "${title}".`;
    const result = await cli([input]);
    expect(result.exitCode).toBe(0);
    expect(result.data!.candidates.map(candidate => candidate.score_parts)).toEqual([
      { title: 1, year: 1, first_author: 1 }, { title: 1, year: 0, first_author: 0 },
    ]);
  });

  it('uses an explicit year to separate otherwise identical titles', async () => {
    state.s2.push(s2Paper({ paperId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', year: 2023, externalIds: {} }));
    const result = await cli([title, '--year', '2024']);
    expect(result.exitCode).toBe(0);
    expect(result.data!.paper!.year).toBe(2024);
    expect(result.data!.candidates[1].score).toBeCloseTo(0.9 / 0.95, 12);
  });

  it('reports a wrong title paired with an explicit ID instead of silently overwriting it', async () => {
    const input = `"Different supplied title". arXiv:2401.12345`;
    const result = await cli([input]);
    expect(result.exitCode).toBe(3);
    expect(result.data!.findings[0]).toMatchObject({ type: 'title_mismatch', supplied: 'Different supplied title', returned: title });
    expect(result.data!.input).toBe(input);
  });

  it.each(['http', 'network'])('returns retryable deferred with every %s source error recorded', async mode => {
    state.errors = { s2: 429, arxiv: 503, crossref: 503 };
    if (mode === 'network') fetchMock.mockRejectedValue(new TypeError('Synthetic network failure'));
    const result = await cli([title]);
    expect(result.exitCode).toBe(4);
    expect(result.data).toMatchObject({ status: 'deferred', incomplete: true, candidates: [] });
    expect(result.data!.paths_tried).toHaveLength(3);
    for (const path of result.data!.paths_tried) expect(path).toMatchObject({ status: 'error', error: expect.any(String), returned: [] });
  });

  it('rejects direct lookup responses carrying a different identifier', async () => {
    fetchMock.mockImplementation(async input => String(input).includes('semanticscholar')
      ? Response.json(s2Paper({ externalIds: { ArXiv: '2401.99999' } }))
      : new Response('<feed><entry><id>https://arxiv.org/abs/2401.99999v1</id><title>Wrong work</title><published>2024-01-01</published></entry></feed>'));
    const result = await cli(['2401.12345']);
    expect(result.exitCode).toBe(3);
    expect(result.data!.candidates).toEqual([]);
    expect(result.data!.findings.filter(finding => finding.type === 'identifier_mismatch')).toHaveLength(2);
    expect(result.data!.findings).toHaveLength(3);
    expect(result.data!.findings[2]).toMatchObject({ type: 'identifier_unresolved', supplied: '2401.12345' });
  });

  it('tries arXiv title search after an empty S2 match and uses its metadata', async () => {
    state.s2 = [];
    state.arxiv = [{ id: '2401.12345v2', title }];
    const result = await cli([title]);
    expect(result.exitCode).toBe(0);
    expect(result.data!.paper).toMatchObject({ arxivId: '2401.12345', arxivVersion: 2, publicationDate: '2024-02-03T00:00:00Z' });
    expect(result.data!.paths_tried.map(path => path.status)).toEqual(['empty', 'returned', 'empty']);
  });

  it('distinguishes successful empty searches from errors and keeps searching after a failed source', async () => {
    state.s2 = [];
    let result = await cli([title]);
    expect(result.exitCode).toBe(3);
    expect(result.data!.incomplete).toBe(false);
    expect(result.data!.paths_tried.every(path => path.status === 'empty')).toBe(true);
    state.errors.s2 = 503;
    const distinctiveTitle = `${title} for autonomous navigation`;
    state.crossref = [crossrefPaper({ title: [distinctiveTitle] })];
    result = await cli([distinctiveTitle]);
    expect(result.exitCode).toBe(0);
    expect(result.data!.incomplete).toBe(true);
    expect(result.data!.paper!.doi).toBe('10.1234/fixture');
  });

  it('caps ranked candidates at five after collecting all sources', async () => {
    state.s2 = Array.from({ length: 5 }, (_, i) => s2Paper({ paperId: String(i).repeat(40), title: `${title} extra${i}`, externalIds: {} }));
    state.crossref = [crossrefPaper()];
    const result = await cli([title]);
    expect(result.data!.candidates).toHaveLength(5);
    expect(result.data!.candidates[0].paper.doi).toBe('10.1234/fixture');
    expect(result.data!.paths_tried[2].returned).toHaveLength(1);
  });
});

describe('approved score boundaries through the CLI', () => {
  const words = Array.from({ length: 100 }, (_, i) => `token${i}`);
  it('keeps a title score of 0.88 ambiguous despite matching year and author', async () => {
    state.s2 = [s2Paper({ title: words.slice(0, 88).join(' '), externalIds: {} })];
    const result = await cli([`Example, A. (2024). "${words.join(' ')}"`]);
    expect(result.exitCode).toBe(2);
    expect(result.data!.status).toBe('ambiguous');
    expect(result.data!.candidates[0].score_parts).toEqual({ title: 0.88, year: 1, first_author: 1 });
    expect(result.data!.candidates[0].score).toBeCloseTo(0.892, 12);
    expect(result.data).not.toHaveProperty('paper');
  });
  it.each([
    [92, 0, 0, 'resolved'], [92, 87, 0, 'resolved'], [92, 88, 2, 'ambiguous'], [92, 92, 2, 'ambiguous'],
    [91, 0, 2, 'ambiguous'], [60, 0, 2, 'ambiguous'], [59, 0, 3, 'unresolved'],
  ])('top %s/100 and runner-up %s/100 yield exit %s', async (top, runner, exitCode, status) => {
    state.s2 = [s2Paper({ title: words.slice(0, top).join(' '), externalIds: {} })];
    if (runner) state.s2.push(s2Paper({ paperId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', title: words.slice(0, runner).join(' '), externalIds: {} }));
    const result = await cli([words.join(' ')]);
    expect(result.exitCode).toBe(exitCode);
    expect(result.data!.status).toBe(status);
    expect(result.data!.candidates[0].score).toBeCloseTo(top / 100, 12);
    expect(result.data!.findings[0]).toMatchObject({ type: 'title_mismatch', supplied: words.join(' ') });
    expect(result.data!.paths_tried).toHaveLength(3);
  });
});

describe('corpus matches and batch exit codes', () => {
  it.each(['arxiv', 'arxiv_id', 'doi', 'title'])('detects existing REF by %s in reference or citation frontmatter', async key => {
    const values: Record<string, string> = { arxiv: 'https://arxiv.org/pdf/2401.12345v2.pdf', arxiv_id: '2401.12345v3', doi: 'https://doi.org/10.1234/FIXTURE', title: 'ｓｅｌｆ {supervised} representation learning' };
    write('documentation/references/REF-123-fixture.md', `---\ntitle: Unrelated title\n${key === 'arxiv' ? `arxiv: ${values[key]}\n` : ''}---\n# Other\n`);
    if (key !== 'arxiv') write('documentation/citations/REF-123-citations.md', `---\nref: REF-123\n${key}: "${values[key]}"\n---\n`);
    const result = await cli([title]);
    expect(result.exitCode).toBe(0);
    expect(result.data!.already_in_corpus).toBe(true);
    expect(result.data!.corpus_matches).toEqual([{ ref: 'REF-123', matched_by: [key.startsWith('arxiv') ? 'arxivId' : key] }]);
  });

  it.each([['unrelated tokens', 3], ['self supervised representation', 2]])('keeps going after middle line %s with worst exit %s', async (middle, code) => {
    write('refs.txt', `${title}\n${middle}\n${title}\n`);
    const before = readFileSync(join(root, 'refs.txt'), 'utf8');
    const result = await cli(['--from-file', 'refs.txt']);
    expect(result.exitCode).toBe(code);
    const data = result.data as unknown as Array<ResolutionResult & { line: number }>;
    expect(data.map(item => item.line)).toEqual([1, 2, 3]);
    expect(data.map(item => item.status)).toEqual(['resolved', code === 3 ? 'unresolved' : 'ambiguous', 'resolved']);
    expect(data.every(item => item.paths_tried.length === 3)).toBe(true);
    expect(readFileSync(join(root, 'refs.txt'), 'utf8')).toBe(before);
  });

  it('uses unresolved as worse than ambiguous in a mixed batch', async () => {
    write('refs.txt', `self supervised representation\nunrelated tokens\n${title}`);
    expect((await cli(['--from-file', 'refs.txt'])).exitCode).toBe(3);
  });

  it('rejects conflicting selectors and malformed flags before HTTP', async () => {
    for (const args of [[title, '--from-file', 'refs.txt'], [title, '--year', 'bad'], ['--from-file'], [title, '--year'], [title, '--write'], []]) {
      const result = await cli(args);
      // Usage errors exit 1 so 2 (ambiguous) and 3 (unresolved) keep their meaning for scripts.
      expect(result.exitCode).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('exposes resolve in corpus help and human output lists every ambiguous candidate', async () => {
    await corpusHandler.help!({ args: [], rawArgs: ['corpus'], cwd: root, frameworkRoot: root });
    expect(output).toContain('aiwg corpus resolve');
    state.s2.push(s2Paper({ paperId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', externalIds: {} }));
    const result = await cli([title], false);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(result.output).toContain('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(result.output).toContain('Tried crossref/bibliographic');
  });
});
