// Traverse the due corpus frontier, suppress known papers, and checkpoint ranked recommendations.
import { AiwgError } from '../../cli/errors.js';
import { SemanticScholarClient } from '../../research/clients/semantic-scholar.js';
import { identityKeys } from '../../research/identity.js';
import { ResearchError, ResearchErrorCode, type ResearchPaper } from '../../research/types.js';
import { findInCorpus, loadCorpusIdentities, type CorpusIdentityRecord } from './resolve-corpus.js';
import { ExpansionQueue, rankCandidates, type ExpansionCandidate } from './expand-queue.js';
import { appendState, expansionPaths, readJsonl, writeQueue, type ExpansionState } from './expand-state.js';
import type { ExpandOptions } from './expand-cli.js';
import { expansionDates } from './expand-dates.js';

export interface ExpansionResult {
  dry_run: boolean;
  incomplete: boolean;
  scoped: number;
  due: number;
  remaining: number;
  processed: ExpansionState[];
  candidates: ExpansionCandidate[];
  overlap_errors: Array<{ paper_id: string; error: string }>;
  paths: ReturnType<typeof expansionPaths>;
}

function seedId(record: CorpusIdentityRecord): string | null {
  // Prefer the primary document and citation frontmatter IDs over body URL fallbacks.
  for (const fields of record.fields) {
    const keys = identityKeys(fields);
    const arxiv = keys.find(key => key.startsWith('arxivId:'));
    const doi = keys.find(key => key.startsWith('doi:'));
    if (arxiv) return `arXiv:${arxiv.slice(8)}`;
    if (doi) return `DOI:${doi.slice(4)}`;
  }
  const arxiv = [...record.keys].find(key => key.startsWith('arxivId:'));
  return arxiv ? `arXiv:${arxiv.slice(8)}` : null;
}

export async function expandCorpus(root: string, cwd: string, options: ExpandOptions): Promise<ExpansionResult> {
  const corpus = loadCorpusIdentities(root);
  if (options.seeds?.some(ref => !corpus.some(record => record.ref === ref))) {
    throw new AiwgError({ code: 'ERR_CORPUS_EXPAND_USAGE', message: 'Every --seeds REF must exist in the corpus', exitCode: 1 });
  }
  const paths = expansionPaths(cwd);
  const previous = new Map(readJsonl<ExpansionState>(paths.ledger).map(row => [row.ref, row]));
  const rejected = new Set(readJsonl<Record<string, unknown>>(paths.rejected)
    .flatMap(row => [...identityKeys((row.paper ?? row) as Record<string, unknown>),
      ...(Array.isArray(row.identity_keys) ? row.identity_keys.filter((key): key is string => typeof key === 'string') : [])]));
  const corpusKeys = new Set(corpus.flatMap(record => [...record.keys]));
  const excluded = (paper: ResearchPaper, aliases: string[] = []) => [...identityKeys(paper), ...aliases]
    .some(key => corpusKeys.has(key) || rejected.has(key));
  const queue = new ExpansionQueue();
  for (const row of readJsonl<ExpansionCandidate>(paths.queue)) {
    if (!excluded(row.paper, row.identity_keys)) queue.add(row.paper, row.seed_refs, row);
  }
  const selected = corpus.filter(record => !options.seeds || options.seeds.includes(record.ref));
  const dates = options.since === undefined ? undefined : expansionDates(root, selected);
  const scoped = selected.filter(record => options.since === undefined || dates!.get(record.path)! >= options.since);
  const now = Date.now();
  const due = scoped.map(record => ({ record, id: seedId(record) })).filter(({ record, id }) => {
    const last = previous.get(record.ref);
    if (!last || last.seed_id !== id) return true;
    if (last.status === 'no-id' && !id) return false;
    return last.status !== 'explored' || !Number.isFinite(Date.parse(last.explored_on))
      || now - Date.parse(last.explored_on) >= options.reexploreMs;
  });
  const client = new SemanticScholarClient();
  const result: ExpansionResult = { dry_run: !options.write, incomplete: false, scoped: scoped.length, due: due.length,
    remaining: Math.max(0, due.length - options.maxSeeds), processed: [], candidates: queue.ranked(), overlap_errors: [], paths };
  for (const { record, id } of due.slice(0, options.maxSeeds)) {
    const row: ExpansionState = { ref: record.ref, seed_id: id, explored_on: new Date().toISOString(),
      status: id ? 'explored' : 'no-id', n_returned: 0 };
    if (id) {
      try {
        const papers = await client.recommendations(id, options.perSeed, options.from);
        row.n_returned = papers.length;
        for (const paper of papers) {
          if (paper.year >= options.minYear && !excluded(paper)) queue.add(paper, [record.ref]);
        }
      } catch (error) {
        row.status = error instanceof ResearchError && error.code === ResearchErrorCode.RF_103 ? 'throttled' : 'not-found';
        row.error = error instanceof Error ? error.message : String(error);
        result.incomplete = true;
      }
    }
    result.processed.push(row);
    result.candidates = queue.ranked();
    if (options.write) {
      writeQueue(paths, result.candidates, renderExpansion(result));
      appendState(paths, row);
    }
  }
  if (options.overlap) {
    for (const candidate of result.candidates.slice(0, 20)) {
      if (candidate.score_parts.overlap !== null) continue;
      try {
        const refs = new Set((await client.recommendationReferences(candidate.paper.s2PaperId ?? candidate.paper.id))
          .flatMap(paper => findInCorpus(root, paper, corpus).map(match => match.ref)));
        candidate.score_parts.overlap = refs.size;
      } catch (error) {
        result.overlap_errors.push({ paper_id: candidate.paper.id, error: error instanceof Error ? error.message : String(error) });
        result.incomplete = true;
      }
    }
    rankCandidates(result.candidates);
  }
  if (options.write) writeQueue(paths, result.candidates, renderExpansion(result));
  return result;
}

export function renderExpansion(result: ExpansionResult): string {
  const lines = ['# Corpus expansion', '', `${result.dry_run ? 'Dry run' : 'Written'}: ${result.processed.length}/${result.due} due seeds; ${result.remaining} remaining; ${result.candidates.length} candidates.`, ''];
  for (const row of result.processed) lines.push(`- ${row.ref}: ${row.status} (${row.seed_id ?? 'no ID'}), ${row.n_returned} returned${row.error ? ` — ${row.error}` : ''}`);
  lines.push('', 'Ranking: distinct seed convergence, then publication year, then optional in-corpus reference overlap.', '');
  for (const [index, row] of result.candidates.entries()) {
    lines.push(`## ${index + 1}. ${row.paper.title}`, '', `Year: ${row.paper.year}; IDs: ${row.identity_keys.filter(key => !key.startsWith('title:')).join(', ')}`,
      `Score components: convergence=${row.score_parts.convergence}, recency=${row.score_parts.recency}, overlap=${row.score_parts.overlap ?? 'not checked'}`,
      `Seed REFs: ${row.seed_refs.join(', ')}`, `Discovery: ${row.discovery.surface}; via: ${row.discovery.via}`, '');
  }
  for (const error of result.overlap_errors) lines.push(`Overlap failed for ${error.paper_id}: ${error.error}`);
  return lines.join('\n') + '\n';
}
