// Guard ordered title scoring and identifier-backed work deduplication.
import { describe, expect, it } from 'vitest';
import { mergePapers, titleSimilarity } from '../../../src/research/reference-match.js';
import type { ResearchPaper } from '../../../src/research/types.js';

const paper = (overrides: Partial<ResearchPaper>): ResearchPaper => ({
  id: '2303.12077', arxivId: '2303.12077', title: 'VAD: Vectorized Scene Representation for Efficient Autonomous Driving',
  authors: [{ name: 'Bo Jiang' }], year: 2023, source: 'arxiv', type: 'preprint', retrievedAt: '', ...overrides,
});

describe('ordered title similarity', () => {
  it('scores the reordered Attention title below the resolution threshold', () => {
    expect(titleSimilarity('Is Attention All You Need?', 'Attention Is All You Need')).toBeLessThan(0.92);
    expect(titleSimilarity('Attention Is All You Need!', 'Attention Is All You Need')).toBe(1);
  });
  it('penalizes repeated tokens as well as order', () => {
    expect(titleSimilarity('attention attention is all you need', 'attention is all you need')).toBeLessThan(1);
  });
  it('preserves ordered subset coverage for the approved boundary fixtures', () => {
    const words = Array.from({ length: 100 }, (_, i) => `token${i}`);
    expect(titleSimilarity(words.join(' '), words.slice(0, 92).join(' '))).toBeCloseTo(0.92, 12);
  });
});

describe('one work with preprint and published identifiers', () => {
  const preprint = paper({ doi: '10.48550/arXiv.2303.12077' });
  const published = paper({ id: '10.1109/iccv51070.2023.00766', arxivId: undefined,
    doi: '10.1109/iccv51070.2023.00766', source: 'crossref', type: 'conference' });
  const bridge = paper({ id: 's2-vad', source: 'semantic-scholar', s2PaperId: 's2-vad', doi: published.doi });
  it.each([
    [preprint, published, bridge], [bridge, published, preprint], [published, preprint, bridge],
  ])('merges the full component regardless of source order', (...records) => {
    const merged = mergePapers(records);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: published.id, source: 'crossref', type: 'conference',
      doi: published.doi, arxivId: '2303.12077', s2PaperId: 's2-vad' });
    expect(preprint.doi).toBe('10.48550/arXiv.2303.12077');
  });
  it('recognizes an arXiv DOI without an explicit arxivId', () => {
    expect(mergePapers([paper({ arxivId: undefined, doi: '10.48550/arXiv.2303.12077' }), paper({})])).toHaveLength(1);
  });
  it('keeps conflicting published DOIs separate even with an arXiv link', () => {
    expect(mergePapers([bridge, paper({ doi: '10.1234/different' })])).toHaveLength(2);
  });
  it('never merges on title, year and author alone', () => {
    expect(mergePapers([paper({ arxivId: undefined }), published])).toHaveLength(2);
  });
});
