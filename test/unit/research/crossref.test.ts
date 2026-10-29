// CrossRef request URLs and response normalization with synthetic HTTP responses.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrossRefClient } from '../../../src/research/clients/crossref.js';
import { ResearchErrorCode } from '../../../src/research/types.js';

const work = {
  DOI: '10.1234/example',
  title: ['Example work', 'Alternate title'],
  author: [{ given: 'Ada', family: 'Lovelace', affiliation: [{ name: 'Institute' }] }],
  published: { 'date-parts': [[2024, 1, 15]] },
  abstract: 'Synthetic abstract',
  'container-title': ['Example Journal'],
  'is-referenced-by-count': 42,
  type: 'journal-article',
};

describe('CrossRefClient', () => {
  let client: CrossRefClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new CrossRefClient();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('looks up an encoded DOI against the real base URL and parses the message', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ message: work }) });
    const paper = await client.getPaperByDoi(work.DOI);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.crossref.org/works/10.1234%2Fexample');
    expect(paper).toEqual({
      id: work.DOI, doi: work.DOI, title: 'Example work', year: 2024,
      authors: [{ name: 'Ada Lovelace', affiliations: ['Institute'] }],
      abstract: 'Synthetic abstract', venue: 'Example Journal', citationCount: 42,
      type: 'journal', source: 'crossref', retrievedAt: expect.any(String),
    });
  });

  it('searches against the real base URL with exact pagination and parsed papers', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
      message: { 'total-results': 4, items: [work] },
    }) });
    const result = await client.search('a & b', { limit: 2, offset: 1 });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.crossref.org/works?query=a+%26+b&rows=2&offset=1');
    expect(result).toMatchObject({ total: 4, offset: 1, limit: 2, hasMore: true,
      papers: [{ id: work.DOI, title: 'Example work', source: 'crossref' }],
    });
  });

  it.each(['https://fixture.invalid/crossref', 'https://fixture.invalid/crossref/'])(
    'retains a configured base path in %s', async (baseUrl) => {
      client = new CrossRefClient({ baseUrl });
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ message: work }) });
      await client.getPaperByDoi(work.DOI);
      expect(fetchMock.mock.calls[0][0]).toBe('https://fixture.invalid/crossref/works/10.1234%2Fexample');
    }
  );

  it('handles an empty final page', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
      message: { 'total-results': 2, items: [] },
    }) });
    expect(await client.search('test', { limit: 2, offset: 2 })).toEqual({
      total: 2, offset: 2, limit: 2, hasMore: false, papers: [],
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.crossref.org/works?query=test&rows=2&offset=2');
  });

  it('reports a missing DOI without retrying', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(client.getPaperByDoi('10.1234/missing')).rejects.toMatchObject({ code: ResearchErrorCode.RF_300 });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.crossref.org/works/10.1234%2Fmissing');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
