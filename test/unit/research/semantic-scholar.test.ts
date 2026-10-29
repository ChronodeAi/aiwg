/**
 * Tests for SemanticScholarClient
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SemanticScholarClient } from '../../../src/research/clients/semantic-scholar.js';
import { ResearchErrorCode } from '../../../src/research/types.js';

describe('SemanticScholarClient', () => {
  let client: SemanticScholarClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('S2_API_KEY', '');
    client = new SemanticScholarClient({
      rateLimit: {
        maxTokens: 100,
        refillRate: 10,
        currentTokens: 100,
        lastRefill: Date.now(),
      },
    });

    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  describe('getPaperByDoi', () => {
    it('should retrieve paper by DOI', async () => {
      const mockResponse = {
        paperId: '123abc',
        title: 'Test Paper',
        abstract: 'This is a test paper',
        year: 2024,
        authors: [
          { authorId: 'author1', name: 'John Doe' },
          { authorId: 'author2', name: 'Jane Smith' },
        ],
        citationCount: 42,
        venue: 'Test Conference',
        externalIds: {
          DOI: '10.1234/test.2024',
          ArXiv: '2024.12345',
        },
        openAccessPdf: {
          url: 'https://example.com/paper.pdf',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const paper = await client.getPaperByDoi('10.1234/test.2024');

      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://api.semanticscholar.org/graph/v1/paper/DOI:10.1234%2Ftest.2024' +
        '?fields=paperId%2Ctitle%2Cabstract%2Cyear%2Cauthors%2CcitationCount%2Cvenue%2CpublicationDate%2CpublicationVenue%2CexternalIds%2CopenAccessPdf'
      );
      expect(paper.id).toBe('123abc');
      expect(paper.title).toBe('Test Paper');
      expect(paper.year).toBe(2024);
      expect(paper.authors).toHaveLength(2);
      expect(paper.authors[0].name).toBe('John Doe');
      expect(paper.doi).toBe('10.1234/test.2024');
      expect(paper.arxivId).toBe('2024.12345');
      expect(paper.citationCount).toBe(42);
      expect(paper.pdfUrl).toBe('https://example.com/paper.pdf');
      expect(paper.source).toBe('semantic-scholar');
    });

    it('should handle missing optional fields', async () => {
      const mockResponse = {
        paperId: '123abc',
        title: 'Minimal Paper',
        authors: [{ name: 'John Doe' }],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const paper = await client.getPaperByDoi('10.1234/test.2024');

      expect(paper.id).toBe('123abc');
      expect(paper.title).toBe('Minimal Paper');
      expect(paper.year).toBe(0);
      expect(paper.abstract).toBeUndefined();
      expect(paper.citationCount).toBeUndefined();
      expect(paper.pdfUrl).toBeUndefined();
    });

    it('should handle null openAccessPdf', async () => {
      const mockResponse = {
        paperId: '123abc',
        title: 'Test Paper',
        authors: [{ name: 'John Doe' }],
        openAccessPdf: null,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const paper = await client.getPaperByDoi('10.1234/test.2024');

      expect(paper.pdfUrl).toBeUndefined();
    });
  });

  describe('getPaperByArxivId', () => {
    it('should retrieve paper by arXiv ID', async () => {
      const mockResponse = {
        paperId: '123abc',
        title: 'arXiv Paper',
        authors: [{ name: 'John Doe' }],
        year: 2024,
        externalIds: {
          ArXiv: '2024.12345',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const paper = await client.getPaperByArxivId('2024.12345');

      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://api.semanticscholar.org/graph/v1/paper/ARXIV:2024.12345' +
        '?fields=paperId%2Ctitle%2Cabstract%2Cyear%2Cauthors%2CcitationCount%2Cvenue%2CpublicationDate%2CpublicationVenue%2CexternalIds%2CopenAccessPdf'
      );
      expect(paper.id).toBe('123abc');
      expect(paper.title).toBe('arXiv Paper');
      expect(paper.arxivId).toBe('2024.12345');
    });
  });

  describe('search', () => {
    it('should search papers', async () => {
      const mockResponse = {
        total: 100,
        offset: 0,
        data: [
          {
            paperId: '123',
            title: 'Paper 1',
            authors: [{ name: 'Author 1' }],
            year: 2024,
          },
          {
            paperId: '456',
            title: 'Paper 2',
            authors: [{ name: 'Author 2' }],
            year: 2023,
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await client.search('machine learning');

      expect(result.total).toBe(100);
      expect(result.papers).toHaveLength(2);
      expect(result.offset).toBe(0);
      expect(result.limit).toBe(10);
      expect(result.hasMore).toBe(true);
      expect(result.papers[0].title).toBe('Paper 1');
      expect(result.papers[1].title).toBe('Paper 2');
    });

    it('should handle pagination', async () => {
      const mockResponse = {
        total: 15,
        offset: 10,
        data: [
          {
            paperId: '789',
            title: 'Paper 11',
            authors: [{ name: 'Author 11' }],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await client.search('test', { limit: 5, offset: 10 });

      expect(result.total).toBe(15);
      expect(result.offset).toBe(10);
      expect(result.hasMore).toBe(false); // 10 + 1 < 15, but we're at the end
    });

    it('should handle custom fields', async () => {
      const mockResponse = {
        total: 1,
        offset: 0,
        data: [
          {
            paperId: '123',
            title: 'Test Paper',
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      await client.search('test', {
        fields: ['paperId', 'title'],
      });

      // Verify the full URL, including the configured API namespace.
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.semanticscholar.org/graph/v1/paper/search?query=test&limit=10&offset=0&fields=paperId%2Ctitle',
        expect.any(Object)
      );
    });
  });

  describe('error handling', () => {
    it('should throw on 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(client.getPaperByDoi('invalid')).rejects.toMatchObject({
        code: ResearchErrorCode.RF_300,
      });
    });

    it('should throw on rate limit after bounded retries', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
      });

      const check = expect(client.getPaperByDoi('test')).rejects.toMatchObject({
        code: ResearchErrorCode.RF_103,
      });
      await vi.runAllTimersAsync(); await check;
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
  });

  describe('namespaces and credentials', () => {
    it.each(['environment', 'config', 'absent'])('sends the %s key only as a header', async (source) => {
      vi.stubEnv('S2_API_KEY', source === 'absent' ? '' : 'synthetic-env-key');
      client = new SemanticScholarClient(source === 'config' ? { apiKey: 'synthetic-config-key' } : {});
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
      await expect(client.requestApi('graph', '/paper/search', { query: 'test' }))
        .resolves.toEqual({ data: [] });

      expect(mockFetch.mock.calls[0][0]).toBe('https://api.semanticscholar.org/graph/v1/paper/search?query=test');
      const headers = new Headers(mockFetch.mock.calls[0][1].headers);
      expect(headers.get('x-api-key')).toBe(source === 'absent' ? null : `synthetic-${source === 'config' ? 'config' : 'env'}-key`);
    });

    it('requests recommendations without changing subsequent graph calls', async () => {
      client = new SemanticScholarClient({ apiKey: 'synthetic-key' });
      const response = { recommendedPapers: [{ paperId: 'recommended', title: 'A recommendation' }] };
      mockFetch.mockResolvedValue({ ok: true, json: async () => response });
      await expect(client.requestApi('recommendations', '/papers/forpaper/seed', { limit: 2, fields: 'paperId,title' }))
        .resolves.toEqual(response);
      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://api.semanticscholar.org/recommendations/v1/papers/forpaper/seed?limit=2&fields=paperId%2Ctitle'
      );
      expect(new Headers(mockFetch.mock.calls[0][1].headers).get('x-api-key')).toBe('synthetic-key');
      const graph = client.requestApi('graph', 'paper/seed');
      await vi.advanceTimersByTimeAsync(1000);
      await graph;
      expect(mockFetch.mock.calls[1][0]).toBe('https://api.semanticscholar.org/graph/v1/paper/seed');
    });

    it('supports independent namespace base URL overrides', async () => {
      client = new SemanticScholarClient({
        baseUrl: 'https://fixture.invalid/proxy/graph/v1/',
        recommendationsBaseUrl: 'https://fixture.invalid/proxy/recommendations/v1/',
      });
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
      await client.requestApi('recommendations', '/papers/forpaper/seed');
      const graph = client.requestApi('graph', '/paper/seed');
      await vi.advanceTimersByTimeAsync(1000);
      await graph;
      expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
        'https://fixture.invalid/proxy/recommendations/v1/papers/forpaper/seed',
        'https://fixture.invalid/proxy/graph/v1/paper/seed',
      ]);
    });

    it.each([401, 403, 500, 'network'])('keeps the key out of %s errors and logs', async (status) => {
      const key = 'synthetic-secret-key';
      client = new SemanticScholarClient({ apiKey: key, retry: { maxRetries: 0, initialDelay: 0, maxDelay: 0, backoffMultiplier: 1 } });
      const logs = ['log', 'warn', 'error', 'debug', 'info'].map((method) =>
        vi.spyOn(console, method as 'log').mockImplementation(() => {})
      );
      if (status === 'network') mockFetch.mockRejectedValueOnce(new Error(`transport echoed ${key}`));
      else mockFetch.mockResolvedValueOnce({ ok: false, status });
      const error = await client.requestApi('graph', '/paper/seed').catch((error) => error);
      expect(mockFetch.mock.calls[0][0]).toBe('https://api.semanticscholar.org/graph/v1/paper/seed');
      expect(error).toMatchObject({ code: status === 401 || status === 403 ? ResearchErrorCode.RF_102 :
        status === 500 ? ResearchErrorCode.RF_200 : ResearchErrorCode.RF_500 });
      expect(`${error}\n${error.stack}\n${JSON.stringify(error)}`).not.toContain(key);
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    });

    it('keeps an invalid header value out of errors', async () => {
      client = new SemanticScholarClient({ apiKey: 'synthetic-secret\ninvalid' });
      const error = await client.requestApi('graph', '/paper/seed').catch((error) => error);
      expect(error).toMatchObject({ code: ResearchErrorCode.RF_500, message: 'Semantic Scholar request failed' });
      expect(`${error}\n${error.stack}\n${JSON.stringify(error)}`).not.toContain('synthetic-secret');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each(['server', 'network'])('paces an unauthenticated %s retry with the default limiter', async (failure) => {
      client = new SemanticScholarClient({ retry: { maxRetries: 1, initialDelay: 10, maxDelay: 10, backoffMultiplier: 1 } });
      if (failure === 'server') mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
      else mockFetch.mockRejectedValueOnce(new Error('synthetic network failure'));
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
      const pending = client.requestApi('graph', '/paper/search', { query: 'retry' });
      await vi.advanceTimersByTimeAsync(999);
      expect(mockFetch.mock.calls[0][0]).toBe('https://api.semanticscholar.org/graph/v1/paper/search?query=retry');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ data: [] });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1][0]).toBe(mockFetch.mock.calls[0][0]);
      expect(new Headers(mockFetch.mock.calls[1][1].headers).has('x-api-key')).toBe(false);
    });
  });
});
