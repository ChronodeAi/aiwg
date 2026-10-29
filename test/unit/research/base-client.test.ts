/**
 * Tests for BaseClient
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseClient, RateLimiter } from '../../../src/research/clients/base.js';
import {
  ClientConfig,
  ResearchErrorCode,
} from '../../../src/research/types.js';

// Test implementation of BaseClient
class TestClient extends BaseClient {
  async testRequest<T>(url: string, options?: RequestInit): Promise<T> {
    return this.request<T>(url, options);
  }

  testBuildUrl(path: string, params: Record<string, string | number | boolean | undefined>): string {
    return this.buildUrl(path, params);
  }
}

describe('RateLimiter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('should allow requests when tokens are available', async () => {
    const limiter = new RateLimiter({
      maxTokens: 10,
      refillRate: 1,
      currentTokens: 10,
      lastRefill: Date.now(),
    });

    await limiter.acquire();

    expect(vi.getTimerCount()).toBe(0);
    expect(limiter.getCurrentTokens()).toBeCloseTo(9, 0);
  });

  it('should wait when no tokens are available', async () => {
    const limiter = new RateLimiter({
      maxTokens: 1,
      refillRate: 10, // 10 tokens per second
      currentTokens: 0,
      lastRefill: Date.now(),
    });

    const acquired = vi.fn();
    const pending = limiter.acquire().then(acquired);
    await vi.advanceTimersByTimeAsync(99);
    expect(acquired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(acquired).toHaveBeenCalledOnce();
    expect(limiter.getCurrentTokens()).toBe(0);
  });

  it('should refill tokens over time', async () => {
    const limiter = new RateLimiter({
      maxTokens: 10,
      refillRate: 10, // 10 tokens per second
      currentTokens: 0,
      lastRefill: Date.now() - 500, // 0.5 seconds ago
    });

    const tokens = limiter.getCurrentTokens();
    expect(tokens).toBeCloseTo(5, 0); // Should have refilled ~5 tokens
  });

  it('should cap tokens at maxTokens', async () => {
    const limiter = new RateLimiter({
      maxTokens: 10,
      refillRate: 10,
      currentTokens: 5,
      lastRefill: Date.now() - 2000, // 2 seconds ago
    });

    const tokens = limiter.getCurrentTokens();
    expect(tokens).toBe(10); // Should be capped at 10
  });
});

describe('BaseClient', () => {
  let client: TestClient;
  let mockFetch: ReturnType<typeof vi.fn>;
  let config: ClientConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    config = {
      baseUrl: 'https://api.example.com',
      timeout: 5000,
      rateLimit: {
        maxTokens: 100,
        refillRate: 10,
        currentTokens: 100,
        lastRefill: Date.now(),
      },
      retry: {
        maxRetries: 3,
        initialDelay: 100,
        maxDelay: 1000,
        backoffMultiplier: 2,
      },
    };

    client = new TestClient(config);

    // Mock global fetch
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('buildUrl', () => {
    it.each([
      ['https://api.semanticscholar.org/graph/v1', '/paper/search'],
      ['https://api.semanticscholar.org/graph/v1', 'paper/search'],
      ['https://api.semanticscholar.org/graph/v1/', '/paper/search'],
      ['https://api.semanticscholar.org/graph/v1/', 'paper/search'],
      ['http://export.arxiv.org/api', '/query'],
      ['https://api.unpaywall.org/v2', '/10.1234%2Fpaper'],
    ])('keeps the base path for %s + %s', (baseUrl, path) => {
      client = new TestClient({ ...config, baseUrl });
      expect(client.testBuildUrl(path, { q: 'a & b', skip: undefined, flag: false }))
        .toBe(`${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}?q=a+%26+b&flag=false`);
    });

    it('should build URL with query parameters', () => {
      const url = client.testBuildUrl('/search', {
        query: 'test',
        limit: 10,
        offset: 0,
      });

      expect(url).toBe('https://api.example.com/search?query=test&limit=10&offset=0');
    });

    it('should skip undefined parameters', () => {
      const url = client.testBuildUrl('/search', {
        query: 'test',
        limit: undefined,
      });

      expect(url).toBe('https://api.example.com/search?query=test');
    });

    it('should handle boolean parameters', () => {
      const url = client.testBuildUrl('/search', {
        flag: true,
      });

      expect(url).toBe('https://api.example.com/search?flag=true');
    });
  });

  describe('request', () => {
    it('should make successful request', async () => {
      const mockData = { id: 1, name: 'test' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockData,
      });

      const result = await client.testRequest<typeof mockData>('https://api.example.com/test');

      expect(result).toEqual(mockData);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should throw on 404 error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(
        client.testRequest('https://api.example.com/test')
      ).rejects.toMatchObject({
        code: ResearchErrorCode.RF_300,
      });
    });

    it('should throw on 429 rate limit error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
      });

      await expect(
        client.testRequest('https://api.example.com/test')
      ).rejects.toMatchObject({
        code: ResearchErrorCode.RF_103,
      });
    });

    it('should throw on 401 unauthorized', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      await expect(
        client.testRequest('https://api.example.com/test')
      ).rejects.toMatchObject({
        code: ResearchErrorCode.RF_102,
      });
    });

    it('should throw on 500 server error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const check = expect(
        client.testRequest('https://api.example.com/test')
      ).rejects.toMatchObject({
        code: ResearchErrorCode.RF_200,
      });
      await vi.runAllTimersAsync();
      await check;
    });

    it('should retry on server errors', async () => {
      // Fail twice, succeed on third attempt
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true }),
        });

      const pending = client.testRequest('https://api.example.com/test');
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result).toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should throw after max retries exceeded', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      const check = expect(
        client.testRequest('https://api.example.com/test')
      ).rejects.toMatchObject({
        code: ResearchErrorCode.RF_200,
      });
      await vi.runAllTimersAsync();
      await check;

      // Should try initial + 3 retries = 4 total
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('should throw timeout error', { timeout: 15000 }, async () => {
      mockFetch.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ ok: true, json: async () => ({}) }), 10000);
          })
      );

      const check = expect(
        client.testRequest('https://api.example.com/test')
      ).rejects.toMatchObject({
        code: ResearchErrorCode.RF_104,
      });
      await vi.runAllTimersAsync();
      await check;
    });

    it('should throw network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network failure'));

      const check = expect(
        client.testRequest('https://api.example.com/test')
      ).rejects.toMatchObject({
        code: ResearchErrorCode.RF_500,
      });
      await vi.runAllTimersAsync();
      await check;
    });

    it.each(['server', 'network'])('waits for a fresh token on a %s retry', async (failure) => {
      client = new TestClient({ ...config, baseUrl: 'https://api.semanticscholar.org/graph/v1' });
      let release!: () => void;
      const acquire = vi.spyOn(RateLimiter.prototype, 'acquire')
        .mockResolvedValueOnce()
        .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
      if (failure === 'server') mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
      else mockFetch.mockRejectedValueOnce(new Error('synthetic network failure'));
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });

      const pending = client.testRequest(client.testBuildUrl('/paper/search', { query: 'test' }));
      await vi.advanceTimersByTimeAsync(100);
      expect(mockFetch.mock.calls[0][0]).toBe('https://api.semanticscholar.org/graph/v1/paper/search?query=test');
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      release();
      await expect(pending).resolves.toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1][0]).toBe(mockFetch.mock.calls[0][0]);
    });
  });
});
