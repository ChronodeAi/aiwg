/**
 * Semantic Scholar API client
 *
 * @module research/clients/semantic-scholar
 */

import { BaseClient } from './base.js';
import {
  ClientConfig,
  ResearchPaper,
  SemanticScholarResponse,
  SearchOptions,
  SearchResult,
  Author,
  ResearchError,
  ResearchErrorCode,
} from '../types.js';

export type SemanticScholarNamespace = 'graph' | 'recommendations';

const IDENTITY_FIELDS = 'paperId,title,abstract,year,authors,citationCount,venue,publicationDate,publicationVenue,externalIds,openAccessPdf';

/**
 * Semantic Scholar API client
 */
export class SemanticScholarClient extends BaseClient {
  private readonly recommendationsBaseUrl: string;

  constructor(config?: Partial<ClientConfig> & { recommendationsBaseUrl?: string }) {
    super({
      baseUrl: 'https://api.semanticscholar.org/graph/v1',
      timeout: 30000,
      rateLimit: {
        maxTokens: 1,
        refillRate: 1, // 1 request per second
        currentTokens: 1,
        lastRefill: Date.now(),
      },
      retry: {
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay: 10000,
        backoffMultiplier: 2,
      },
      ...config,
      apiKey: config?.apiKey ?? process.env.S2_API_KEY,
    });
    this.recommendationsBaseUrl = config?.recommendationsBaseUrl ??
      'https://api.semanticscholar.org/recommendations/v1';
  }

  /** Request raw JSON in an explicit namespace; baseUrl overrides graph only. */
  async requestApi<T>(
    namespace: SemanticScholarNamespace,
    path: string,
    params: Record<string, string | number | boolean | undefined> = {}
  ): Promise<T> {
    const baseUrl = namespace === 'graph'
      ? this.config.baseUrl
      : this.recommendationsBaseUrl;
    return this.request<T>(this.buildUrl(path, params, baseUrl));
  }

  /** Attach credentials once for all endpoints and keep transport causes private. */
  protected override async request<T>(url: string, options: RequestInit = {}): Promise<T> {
    const key = this.config.apiKey;

    try {
      const headers = new Headers(options.headers);
      if (key) headers.set('x-api-key', key);
      return await super.request<T>(url, { ...options, headers });
    } catch (error) {
      // A transport error can echo request headers, including in its cause/stack.
      if (key) {
        throw new ResearchError(
          error instanceof ResearchError ? error.code : ResearchErrorCode.RF_500,
          error instanceof ResearchError
            ? error.message.replaceAll(key, '[REDACTED]')
            : 'Semantic Scholar request failed'
        );
      }
      throw error;
    }
  }

  /**
   * Get paper by DOI
   */
  async getPaperByDoi(doi: string): Promise<ResearchPaper> {
    return this.getPaperById(`DOI:${doi}`);
  }

  /**
   * Get paper by arXiv ID
   */
  async getPaperByArxivId(arxivId: string): Promise<ResearchPaper> {
    return this.getPaperById(`ARXIV:${arxivId}`);
  }

  /** Graph lookup by paperId, DOI:, ARXIV:, ACL:, CorpusId: or URL: identifier. */
  async getPaperById(identifier: string): Promise<ResearchPaper> {
    const colon = identifier.indexOf(':');
    const encoded = colon < 0 ? encodeURIComponent(identifier)
      : `${identifier.slice(0, colon + 1)}${encodeURIComponent(identifier.slice(colon + 1))}`;
    const response = await this.requestApi<SemanticScholarResponse>('graph', `/paper/${encoded}`, { fields: IDENTITY_FIELDS });
    return this.transformResponse(response);
  }

  /** Title matching uses the graph match endpoint, retaining every returned candidate. */
  async matchTitle(query: string): Promise<ResearchPaper[]> {
    const response = await this.requestApi<{ data: SemanticScholarResponse[] }>('graph', '/paper/search/match', {
      query, fields: IDENTITY_FIELDS,
    });
    return response.data.map(paper => this.transformResponse(paper));
  }

  /**
   * Search papers by query
   */
  async search(
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResult> {
    const {
      limit = 10,
      offset = 0,
      fields = IDENTITY_FIELDS.split(','),
    } = options;

    const url = this.buildUrl('/paper/search', {
      query,
      limit,
      offset,
      fields: fields.join(','),
    });

    const response = await this.request<{
      total: number;
      offset: number;
      data: SemanticScholarResponse[];
    }>(url);

    return {
      total: response.total,
      papers: response.data.map((paper) => this.transformResponse(paper)),
      offset: response.offset,
      limit,
      hasMore: response.offset + limit < response.total,
    };
  }

  /**
   * Transform Semantic Scholar response to ResearchPaper
   */
  private transformResponse(response: SemanticScholarResponse): ResearchPaper {
    const authors: Author[] = (response.authors || []).map((author) => ({
      name: author.name,
      id: author.authorId,
    }));

    return {
      id: response.paperId,
      s2PaperId: response.paperId,
      title: response.title,
      authors,
      year: response.year || 0,
      abstract: response.abstract,
      doi: response.externalIds?.DOI,
      arxivId: response.externalIds?.ArXiv,
      aclId: response.externalIds?.ACL,
      openReviewId: response.externalIds?.OpenReview,
      publicationDate: response.publicationDate ?? undefined,
      publicationVenue: response.publicationVenue ?? undefined,
      venue: response.venue,
      citationCount: response.citationCount,
      pdfUrl: response.openAccessPdf?.url,
      source: 'semantic-scholar',
      retrievedAt: new Date().toISOString(),
    };
  }
}
