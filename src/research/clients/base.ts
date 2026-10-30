/**
 * Base API client with rate limiting and retry logic
 *
 * @module research/clients/base
 */

import {
  ClientConfig,
  RateLimitConfig,
  RetryConfig,
  ResearchError,
  ResearchErrorCode,
} from '../types.js';

// Bound server-directed cooldowns for both retries and later shared-client requests.
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Token bucket rate limiter
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private blockedUntil = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private config: RateLimitConfig) {
    this.tokens = config.currentTokens;
    this.lastRefill = config.lastRefill; // Use config value, not Date.now()
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // Convert to seconds
    const tokensToAdd = elapsed * this.config.refillRate;

    this.tokens = Math.min(this.config.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Acquire a token, waiting if necessary
   */
  acquire(): Promise<void> {
    const pending = this.queue.then(() => this.acquireToken());
    this.queue = pending.catch(() => {});
    return pending;
  }

  /** Share a server cooldown with subsequent requests, including exhausted retries. */
  defer(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + ms);
  }

  private async acquireToken(): Promise<void> {
    for (;;) {
      this.refill();
      const waitMs = Math.max(this.blockedUntil - Date.now(),
        (1 - this.tokens) / this.config.refillRate * 1000);
      if (waitMs <= 0) { this.tokens -= 1; return; }
      await this.sleep(Math.ceil(waitMs));
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get current token count (for testing)
   */
  getCurrentTokens(): number {
    this.refill();
    return this.tokens;
  }
}

/**
 * Base API client with common functionality
 */
export abstract class BaseClient {
  protected rateLimiter: RateLimiter;
  protected retryConfig: RetryConfig;

  constructor(protected config: ClientConfig) {
    this.rateLimiter = new RateLimiter(config.rateLimit);
    this.retryConfig = config.retry;
  }

  /**
   * Execute an HTTP request with rate limiting and retry logic
   */
  protected async request<T>(
    url: string,
    options: RequestInit = {}
  ): Promise<T> {
    // Execute with retry
    return this.executeWithRetry<T>(url, options);
  }

  /** XML clients use the same limiter, timeout and HTTP retry policy as JSON. */
  protected requestText(url: string, options: RequestInit = {}): Promise<string> {
    return this.executeWithRetry(url, options, 0, undefined, response => response.text());
  }

  /**
   * Execute request with exponential backoff retry
   */
  private async executeWithRetry<T>(
    url: string,
    options: RequestInit,
    attempt = 0,
    firstError?: ResearchError,
    read: (response: Response) => Promise<T> = response => response.json() as Promise<T>
  ): Promise<T> {
    // Every attempt consumes a token, after any retry backoff and before timeout.
    await this.rateLimiter.acquire();

    const controller = new AbortController();
    let timeoutId: NodeJS.Timeout | undefined;

    try {
      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(
            new ResearchError(
              ResearchErrorCode.RF_104,
              `Request timeout after ${this.config.timeout}ms`
            )
          );
        }, this.config.timeout);
      });

      // Create fetch promise
      const fetchPromise = fetch(url, {
        ...options,
        signal: controller.signal,
      });

      // Race between fetch and timeout
      const response = await Promise.race([fetchPromise, timeoutPromise]);

      // Clear timeout if fetch completed first
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const error = await this.handleHttpError(response);
        throw error;
      }

      return await read(response);
    } catch (error) {
      // Clear timeout on error
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      // Handle abort (timeout)
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ResearchError(
          ResearchErrorCode.RF_104,
          `Request timeout after ${this.config.timeout}ms`,
          error
        );
      }

      // Track the first error for better error reporting
      const currentFirstError =
        firstError || (error instanceof ResearchError ? error : undefined);

      // A throttle cooldown survives exhaustion so the next batch line also waits.
      const delay = Math.max(this.calculateBackoff(attempt),
        error instanceof ResearchError ? Math.min(error.retryAfterMs ?? 0, MAX_RETRY_AFTER_MS) : 0);
      if (error instanceof ResearchError && error.code === ResearchErrorCode.RF_103) {
        this.rateLimiter.defer(delay);
      }

      // Retry transient HTTP failures with the same limiter on every attempt.
      if (error instanceof ResearchError) {
        // Retry on transient errors
        if (this.isRetriable(error) && attempt < this.retryConfig.maxRetries) {
          if (error.code !== ResearchErrorCode.RF_103) await this.sleep(delay);
          return this.executeWithRetry<T>(
            url,
            options,
            attempt + 1,
            currentFirstError,
            read
          );
        }
        throw error;
      }

      // Retry on network errors
      if (attempt < this.retryConfig.maxRetries) {
        const delay = this.calculateBackoff(attempt);
        await this.sleep(delay);
        return this.executeWithRetry<T>(
          url,
          options,
          attempt + 1,
          currentFirstError,
          read
        );
      }

      // If we have a first error from an HTTP response, throw that instead of generic network error
      if (currentFirstError) {
        throw currentFirstError;
      }

      throw new ResearchError(
        ResearchErrorCode.RF_500,
        'Network error',
        error as Error
      );
    }
  }

  /**
   * Handle HTTP error responses
   */
  private async handleHttpError(response: Response): Promise<ResearchError> {
    const status = response.status;

    if (status === 404) {
      return new ResearchError(
        ResearchErrorCode.RF_300,
        'Resource not found'
      );
    }

    if (status === 429) {
      const error = new ResearchError(ResearchErrorCode.RF_103, 'Rate limit exceeded');
      const value = response.headers?.get('retry-after');
      if (value) {
        const ms = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now();
        if (Number.isFinite(ms)) error.retryAfterMs = Math.max(0, ms);
      }
      return error;
    }

    if (status === 401 || status === 403) {
      return new ResearchError(
        ResearchErrorCode.RF_102,
        'Invalid API key or unauthorized'
      );
    }

    if (status >= 500) {
      return new ResearchError(
        ResearchErrorCode.RF_200,
        'API server error'
      );
    }

    return new ResearchError(
      ResearchErrorCode.RF_100,
      `HTTP error ${status}`
    );
  }

  /**
   * Determine if an error is retriable
   */
  private isRetriable(error: unknown): boolean {
    if (error instanceof ResearchError) {
      // Rate limits and server errors are transient.
      return error.code === ResearchErrorCode.RF_200 || error.code === ResearchErrorCode.RF_103;
    }

    // Retry on network errors
    return true;
  }

  /**
   * Calculate exponential backoff delay
   */
  private calculateBackoff(attempt: number): number {
    const delay =
      this.retryConfig.initialDelay *
      Math.pow(this.retryConfig.backoffMultiplier, attempt);
    return Math.min(delay, this.retryConfig.maxDelay);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Build URL with query parameters
   */
  protected buildUrl(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    baseUrl = this.config.baseUrl
  ): string {
    // API endpoints are relative to the complete base path, even with a slash.
    const url = new URL(path.replace(/^\/+/, ''), `${baseUrl.replace(/\/+$/, '')}/`);

    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        url.searchParams.append(key, String(value));
      }
    });

    return url.toString();
  }
}
