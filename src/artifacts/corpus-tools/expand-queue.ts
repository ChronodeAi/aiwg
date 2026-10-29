// Merge recommendation identities and retain auditable convergence, recency and provenance.
import { identityKeys, normalizeIdentity } from '../../research/identity.js';
import type { ResearchPaper } from '../../research/types.js';

export interface ExpansionCandidate {
  paper: ResearchPaper;
  identity_keys: string[];
  seed_refs: string[];
  score_parts: { convergence: number; recency: number; overlap: number | null };
  discovery: { surface: 's2-recommendation'; via: string };
}

export function rankCandidates(rows: ExpansionCandidate[]): ExpansionCandidate[] {
  return rows.sort((a, b) => b.score_parts.convergence - a.score_parts.convergence
    || b.score_parts.recency - a.score_parts.recency
    || (b.score_parts.overlap ?? -1) - (a.score_parts.overlap ?? -1)
    || a.paper.id.localeCompare(b.paper.id));
}

export class ExpansionQueue {
  private rows = new Set<ExpansionCandidate>();
  private byKey = new Map<string, ExpansionCandidate>();

  add(paper: ResearchPaper, refs: string[], previous?: ExpansionCandidate): void {
    const normalized = normalizeIdentity(paper);
    paper = { ...paper, ...Object.fromEntries(Object.entries(normalized).filter(([key, value]) => key !== 'title' && value !== undefined)) };
    const keys = new Set([...identityKeys(paper), ...(previous?.identity_keys ?? [])]);
    const matches = new Set([...keys].flatMap(key => this.byKey.get(key) ? [this.byKey.get(key)!] : []));
    const seeds = new Set(refs);
    let overlap = previous?.score_parts.overlap ?? null;
    for (const match of matches) {
      this.rows.delete(match);
      for (const key of match.identity_keys) keys.add(key);
      for (const ref of match.seed_refs) seeds.add(ref);
      paper = { ...match.paper, ...Object.fromEntries(Object.entries(paper).filter(([, value]) => value !== undefined)) };
      overlap ??= match.score_parts.overlap;
    }
    const seedRefs = [...seeds].sort();
    const row: ExpansionCandidate = { paper, identity_keys: [...keys].sort(), seed_refs: seedRefs,
      score_parts: { convergence: seedRefs.length, recency: paper.year || 0, overlap },
      discovery: { surface: 's2-recommendation', via: `S2 recommendations for ${seedRefs.join(', ')}` } };
    this.rows.add(row);
    for (const key of keys) this.byKey.set(key, row);
  }

  ranked(): ExpansionCandidate[] { return rankCandidates([...this.rows]); }
}
