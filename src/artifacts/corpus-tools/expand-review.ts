// Review persisted expansion identities without requesting papers or triggering induction.
import { AiwgError } from '../../cli/errors.js';
import { identityKeys, parseResearchIdentifier } from '../../research/identity.js';
import type { ExpansionCandidate } from './expand-queue.js';
import { compactState, expansionPaths, readJsonl, writeJsonl, writeQueue } from './expand-state.js';
import { renderExpansion } from './expand.js';

export const REVIEW_USAGE = `aiwg corpus review [list] [--json]
aiwg corpus review accept <id> [--brief] [--write] [--json]
aiwg corpus review reject <id> [--reason TEXT] [--write] [--json]
aiwg corpus review defer <id> [--write] [--json]
IDs: paper.id, full identity keys, bare S2 IDs, or complete DOI/arXiv/OpenReview/ACL/S2 aliases and URLs.
Default: dry run. Accept/defer retain the candidate with review metadata; reject records its identities in rejected-candidates.jsonl and removes it from the queue.
--brief emits an induct-research brief to stdout (JSON: brief); it never inducts or files issues.
Exit codes: 0 complete, 1 usage or storage error.
`;

type Action = 'list' | 'accept' | 'reject' | 'defer';

function usage(message: string): never {
  throw new AiwgError({ code: 'ERR_CORPUS_REVIEW_USAGE', message, exitCode: 1, hint: REVIEW_USAGE.trim() });
}

function matches(row: ExpansionCandidate, id: string): boolean {
  const recognized = parseResearchIdentifier(id);
  const parsed = recognized?.matched === id ? recognized : undefined;
  const field = parsed && ({ arxiv: 'arxivId', doi: 'doi', s2: 's2PaperId', openreview: 'openReviewId', acl: 'aclId' } as const)[parsed.kind];
  const keys = new Set([id, ...identityKeys({ s2PaperId: id, ...(field ? { [field]: parsed!.id } : {}) })]);
  return row.paper.id === id || [...row.identity_keys, ...identityKeys(row.paper)]
    .some(key => keys.has(key));
}

function brief(row: ExpansionCandidate): string {
  return ['# Induction brief for induct-research', '', `Title: ${row.paper.title}`,
    `Paper ID: ${row.paper.id}`, `IDs: ${row.identity_keys.filter(key => !key.startsWith('title:')).join(', ')}`,
    `Seed REFs: ${row.seed_refs.join(', ')}`,
    `Score components: convergence=${row.score_parts.convergence}, recency=${row.score_parts.recency}, overlap=${row.score_parts.overlap ?? 'not checked'}`,
    `Discovery: ${row.discovery.surface}; via: ${row.discovery.via}`, '',
    'Use induct-research only when explicitly requested. Preserve the seed REFs and discovery provenance in the citation sidecar.', ''].join('\n');
}

export async function reviewCli(args: string[], cwd: string): Promise<void> {
  const positional: string[] = [];
  const seen = new Set<string>();
  let reason: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('-')) { positional.push(token); continue; }
    if (!['--json', '--write', '--brief', '--reason'].includes(token)) usage(`Unknown review option: ${token}`);
    if (seen.has(token)) usage(`${token} may only be supplied once`);
    seen.add(token);
    if (token === '--reason') {
      reason = args[++i];
      if (!reason?.trim() || reason.startsWith('-')) usage('--reason requires text');
    }
  }
  const action = (positional[0] ?? 'list') as Action;
  if (!['list', 'accept', 'reject', 'defer'].includes(action)) usage(`Unknown review action: ${action}`);
  if (positional.length !== (action === 'list' ? (positional.length ? 1 : 0) : 2)) usage(`${action} ${action === 'list' ? 'takes no ID' : 'requires one ID'}`);
  if (seen.has('--reason') && action !== 'reject') usage('--reason is only valid with reject');
  if (seen.has('--brief') && action !== 'accept') usage('--brief is only valid with accept');
  if (seen.has('--write') && action === 'list') usage('--write requires accept, reject or defer');
  const paths = expansionPaths(cwd);
  const candidates = readJsonl<ExpansionCandidate>(paths.queue);
  // Validate all storage before mutating any file, including the ledger compacted on writes.
  const rejected = readJsonl<unknown>(paths.rejected);
  readJsonl(paths.ledger);
  let change: { before: ExpansionCandidate; after: ExpansionCandidate } | undefined;
  if (action !== 'list') {
    const found = candidates.filter(row => matches(row, positional[1]));
    if (found.length !== 1) usage(found.length ? `Ambiguous candidate ID: ${positional[1]}` : `Unknown candidate ID: ${positional[1]}`);
    const before = found[0];
    const after: ExpansionCandidate = { ...before, review: {
      status: action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'deferred',
      reviewed_on: new Date().toISOString(), ...(reason !== undefined ? { reason } : {}),
    } };
    change = { before, after };
    const index = candidates.indexOf(before);
    if (action === 'reject') candidates.splice(index, 1);
    else candidates[index] = after;
  }
  const result = { dry_run: !seen.has('--write'), action, candidates, ...(change ? { change } : {}),
    ...(seen.has('--brief') ? { brief: brief(change!.after) } : {}) };
  const report = renderExpansion({ ...result, incomplete: false, scoped: 0, due: 0, remaining: 0,
    processed: [], overlap_errors: [], paths });
  if (seen.has('--write')) {
    // Persist suppression first: a failed queue write cannot resurrect a rejected identity.
    if (action === 'reject') writeJsonl(paths.rejected, [...rejected, change!.after]);
    writeQueue(paths, candidates, report);
    // Queue/report may already be replaced on compaction failure; expand reconciles
    // from persisted suppression and retries compaction without resurrecting rejections.
    compactState(paths);
  }
  const summary = change ? `${result.dry_run ? 'Dry run' : 'Written'}: ${action} ${change.after.paper.id}${reason ? ` (${reason})` : ''}\n` : '';
  process.stdout.write(seen.has('--json') ? JSON.stringify(result, null, 2) + '\n' : summary + report + (result.brief ?? ''));
}
