// Parse partial citations and score distinct candidate identities without choosing close matches.
import { normalizeIdentity, normalizeTitle, parseResearchIdentifier, type ResearchIdentifier } from './identity.js';
import type { ResearchPaper } from './types.js';

export interface PartialReference {
  input: string;
  identifier?: ResearchIdentifier;
  title?: string;
  year?: number;
  firstAuthor?: string;
}

export interface ScoredPaper {
  paper: ResearchPaper;
  score: number;
  score_parts: { title: number; year?: number; first_author?: number; identifier?: number };
}

export type ResolutionStatus = 'resolved' | 'ambiguous' | 'unresolved';

/** Common quoted, APA-style and title-plus-year citations; retain the untouched input. */
export function parsePartialReference(input: string, year?: number): PartialReference {
  const identifier = parseResearchIdentifier(input);
  let rest = identifier ? input.replace(identifier.matched, '') : input;
  rest = rest.replace(/^\s*\[\d+\]\s*/, '').trim();
  const date = rest.match(/\b((?:18|19|20|21)\d{2})\b/);
  const quoted = rest.match(/["“]([^"”]+)["”]/);
  const apa = rest.match(/^(.+?)\s*\(((?:18|19|20|21)\d{2})\)\.?\s+(.+)$/);
  const authorYear = rest.match(/^(.+?(?:et al\.|,\s*[A-Z]\.))\s*((?:18|19|20|21)\d{2})\.?\s+(.+)$/);
  const bibliography = apa ?? authorYear;
  const firstAuthor = bibliography?.[1].split(/,|\s+et al\.|\s+and\s+|\s+&\s+/)[0].trim();
  if (quoted) rest = quoted[1];
  else if (bibliography) rest = bibliography[3].split(/\.\s+/)[0];
  else if (date) rest = rest.replace(date[0], '');
  rest = rest.replace(/^[\s.,;:()[\]{}"']+|[\s.,;:()[\]{}"']+$/g, '').trim();
  return { input, identifier, title: normalizeTitle(rest) ? rest : undefined, year: year ?? (date ? Number(date[1]) : undefined), firstAuthor };
}

/** Jaccard token-set similarity avoids substring matches scoring as exact titles. */
export function titleSimilarity(left: string, right: string): number {
  const a = new Set(normalizeTitle(left).split(' ').filter(Boolean));
  const b = new Set(normalizeTitle(right).split(' ').filter(Boolean));
  const union = new Set([...a, ...b]).size;
  return union ? [...a].filter(token => b.has(token)).length / union : 0;
}

function surname(name: string): string {
  return normalizeTitle(name.includes(',') ? name.split(',')[0] : name.trim().split(/\s+/).at(-1) ?? '');
}

/** Title weight .9; supplied year and first author each add .05, then renormalize. */
export function scorePaper(reference: PartialReference, paper: ResearchPaper, verifiedId = false): ScoredPaper {
  const title = reference.title ? titleSimilarity(reference.title, paper.title) : (verifiedId ? 1 : 0);
  const parts: ScoredPaper['score_parts'] = { title };
  let sum = 0.9 * title;
  let weight = 0.9;
  if (reference.year !== undefined) {
    parts.year = paper.year === reference.year ? 1 : 0;
    sum += 0.05 * parts.year;
    weight += 0.05;
  }
  if (reference.firstAuthor) {
    parts.first_author = surname(reference.firstAuthor) === surname(paper.authors[0]?.name ?? '') ? 1 : 0;
    sum += 0.05 * parts.first_author;
    weight += 0.05;
  }
  if (verifiedId) parts.identifier = 1;
  return { paper, score: sum / weight, score_parts: parts };
}

/** Apply inclusive approved boundaries; epsilon only compensates floating-point subtraction. */
export function classifyCandidates(candidates: ScoredPaper[]): ResolutionStatus {
  const best = candidates[0]?.score ?? 0;
  if (best + 1e-12 < 0.6) return 'unresolved';
  const margin = best - (candidates[1]?.score ?? 0);
  return best + 1e-12 >= 0.92 && margin + 1e-12 >= 0.05 ? 'resolved' : 'ambiguous';
}

/** Merge corroborating records, retaining same-title papers with conflicting identifiers. */
export function mergePapers(papers: ResearchPaper[]): ResearchPaper[] {
  const merged: ResearchPaper[] = [];
  for (const paper of papers) {
    const identity = normalizeIdentity(paper);
    const previous = merged.find(existing => {
      const other = normalizeIdentity(existing);
      const ids = ['arxivId', 'doi', 's2PaperId', 'openReviewId', 'aclId'] as const;
      if (ids.some(key => identity[key] && other[key] && identity[key] !== other[key])) return false;
      return ids.some(key => identity[key] && identity[key] === other[key]) ||
        Boolean(identity.title && identity.title === other.title);
    });
    if (!previous) { merged.push({ ...paper }); continue; }
    // Source order determines metadata precedence; later sources only fill missing fields.
    for (const [key, value] of Object.entries(paper)) {
      if (value !== undefined && (!(previous as unknown as Record<string, unknown>)[key] ||
          (Array.isArray(previous[key as keyof ResearchPaper]) && (previous[key as keyof ResearchPaper] as unknown[]).length === 0))) {
        (previous as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  return merged;
}
