// Unpaywall's v2 prefix, email parameter, and open-access response normalization.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnpaywallClient } from '../../../src/research/clients/unpaywall.js';
import { ResearchErrorCode } from '../../../src/research/types.js';

describe('UnpaywallClient', () => {
  let client: UnpaywallClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new UnpaywallClient({ email: 'reader@example.org' });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the real v2 base URL and parses the open-access location', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
      doi: '10.1234/example', title: 'Example', year: 2024,
      authors: [{ given: 'Ada', family: 'Lovelace' }], journal_name: 'Journal',
      best_oa_location: { url_for_pdf: 'https://fixture.invalid/paper.pdf', url: 'https://fixture.invalid/paper' },
    }) });
    const paper = await client.getPaperByDoi('10.1234/example');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.unpaywall.org/v2/10.1234%2Fexample?email=reader%40example.org');
    expect(paper).toEqual({
      id: '10.1234/example', doi: '10.1234/example', title: 'Example', year: 2024,
      authors: [{ name: 'Ada Lovelace' }], venue: 'Journal',
      pdfUrl: 'https://fixture.invalid/paper.pdf', source: 'unpaywall', retrievedAt: expect.any(String),
    });
  });

  it('falls back to the location URL when there is no PDF link', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
      doi: '10.1234/example', best_oa_location: { url: 'https://fixture.invalid/open' },
    }) });
    expect(await client.checkOpenAccess('10.1234/example')).toBe('https://fixture.invalid/open');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.unpaywall.org/v2/10.1234%2Fexample?email=reader%40example.org');
  });

  it('returns null for a closed-access work', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ doi: '10.1234/closed', best_oa_location: null }) });
    expect(await client.checkOpenAccess('10.1234/closed')).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.unpaywall.org/v2/10.1234%2Fclosed?email=reader%40example.org');
  });

  it('returns null for a missing DOI without retrying', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    expect(await client.checkOpenAccess('10.1234/missing')).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.unpaywall.org/v2/10.1234%2Fmissing?email=reader%40example.org');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a missing email before any HTTP request', async () => {
    await expect(new UnpaywallClient().getPaperByDoi('10.1234/example')).rejects
      .toMatchObject({ code: ResearchErrorCode.RF_101 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
