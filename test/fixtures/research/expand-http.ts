// Fake recommendations and graph HTTP endpoints; unrecognized requests fail closed.
import type { SemanticScholarResponse } from '../../../src/research/types.js';

export interface ExpansionHttp {
  recommendations: Record<string, SemanticScholarResponse[] | number | 'network' | 'malformed'>;
  references: Record<string, SemanticScholarResponse[] | number>;
  calls: Array<{ url: URL; time: number; headers: Headers }>;
}

export function expansionHttp(): ExpansionHttp { return { recommendations: {}, references: {}, calls: [] }; }

export function recommended(paperId: string, title = `Candidate ${paperId}`, year = 2024, externalIds = {}): SemanticScholarResponse {
  return { paperId, title, year, authors: [], externalIds };
}

export function expansionFetch(state: ExpansionHttp) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    state.calls.push({ url, time: Date.now(), headers: new Headers(init?.headers) });
    if (url.origin !== 'https://api.semanticscholar.org') throw new Error(`Unexpected fixture origin: ${url.origin}`);
    if (url.pathname.startsWith('/recommendations/v1/papers/forpaper/')) {
      const id = decodeURIComponent(url.pathname.slice('/recommendations/v1/papers/forpaper/'.length));
      const value = state.recommendations[id];
      if (value === undefined) throw new Error(`Unconfigured seed: ${id}`);
      if (value === 'network') throw new TypeError('Synthetic transport failure');
      if (value === 'malformed') return Response.json({ wrong: [] });
      return typeof value === 'number' ? new Response('', { status: value }) : Response.json({ recommendedPapers: value });
    }
    if (url.pathname.startsWith('/graph/v1/paper/')) {
      const value = state.references[decodeURIComponent(url.pathname.slice('/graph/v1/paper/'.length))];
      if (value === undefined) throw new Error(`Unconfigured overlap: ${url.pathname}`);
      return typeof value === 'number' ? new Response('', { status: value }) : Response.json({ references: value });
    }
    throw new Error(`Unexpected fixture endpoint: ${url.pathname}`);
  };
}
