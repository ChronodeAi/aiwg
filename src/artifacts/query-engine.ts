/**
 * Artifact Query Engine
 *
 * Searches the artifact index by keyword, type, phase, tags, and path pattern.
 * Returns ranked results in human-readable or JSON format.
 *
 * @implements #416
 * @source @src/artifacts/types.ts
 * @tests @test/unit/artifacts/query-engine.test.ts
 */

import { refreshFrameworkCapabilities, resolveFrameworkCorpusRoot, isCorpusBundleInstalled } from './framework-capabilities.js';
import { resolveFrameworkIndexRoot } from './framework-index-paths.js';
import { ensureRelations, selectPrebuiltRelations, emptyRuleStats, type RelationsReader, type RelationTargetType, type RuleStats } from './relations.js';
import { minimatch } from 'minimatch';
import { inferRuleActivation } from '../rules/activation.mjs';
import type { DiscoveryShadowRoute } from './discovery-shadow.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { QueryParams, QueryResult, MetadataEntry, GraphType, ArtifactIndex } from './types.js';
import {
  OPERATIONAL_DISCOVERY_TYPES,
  OPERATIONAL_SHOW_TYPES,
  isOperationalShowType,
  loadGlobalGraphConfigs,
  getGraphIndexDir,
} from './types.js';
import { loadMetadataIndex, loadGraphIndexFile } from './index-reader.js';
import { bm25Rank, type FullTextDoc } from './fulltext.js';
import { parseFrontmatter, parseFlowDoc, extractMarkdownLinks } from './index-builder.js';
import {
  applyFacetFusion,
  diagnoseFacetActivations,
  type FacetScoreDiagnostic,
} from './discover-facets.js';
import {
  recordTypeForEntry,
  stableRecordId,
  type AiwgFortemiRecord,
} from './browser-export.js';
import { loadProviderModelMetadata } from '../models/provider-models.js';
import { projectAiwgPath, projectControlPath } from '../config/project-artifacts.js';
import {
  operationalStateQueryProjection,
  type OperationalStateQueryProjection,
} from './operational-state.js';
import type {
  ResourceSource,
  VerifiedWebRelease,
  WebReleaseOptions,
} from '../resources/web-release.js';

function normalizeIndexedPath(entryPath: string): string {
  return entryPath.replace(/\\/g, '/');
}

/**
 * Resolve an index entry's source file path and read its body (frontmatter
 * stripped). Entry paths are normally relative to the project; framework-graph
 * entries may be absolute or anchored to $AIWG_ROOT. Returns null when the
 * file can't be read (stale index entry) so full-text ranking skips it.
 */
function readEntryBody(cwd: string, entryPath: string): string | null {
  const candidates: string[] = [];
  if (path.isAbsolute(entryPath)) candidates.push(entryPath);
  else {
    const normalizedPath = normalizeIndexedPath(entryPath);
    if (normalizedPath.startsWith('.aiwg/')) {
      candidates.push(projectAiwgPath(cwd, normalizedPath.slice('.aiwg/'.length)));
    }
    candidates.push(path.resolve(cwd, normalizedPath));
    if (process.env.AIWG_ROOT) candidates.push(path.resolve(process.env.AIWG_ROOT, normalizedPath));
  }
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      return parseFrontmatter(raw).body;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}


export interface QueryOptions {
  json?: boolean;
  graph?: GraphType;
  backend?: 'local' | 'fortemi-core';
}

const DEFAULT_ARTIFACT_SEARCH_BACKEND: 'fortemi-core' = 'fortemi-core';

const DISCOVER_TYPE_ORDER = new Map(
  [...OPERATIONAL_DISCOVERY_TYPES, 'hook', 'doc'].map((type, index) => [type, index]),
);

function canonicalLocalityRank(entryPath: string): number {
  const normalized = entryPath.replace(/\\/g, '/');
  if (normalized.startsWith('.aiwg/') || normalized.includes('/.aiwg/')) return 0;
  // Top-level persona mirrors are the least canonical source for a name a bundle
  // also owns. Without this they fell into the catch-all below and scored 1,
  // beating the bundle copy at 2 — the opposite of #1643. It only ever looked
  // correct because a populated user index supplied provenance and `scopeRank`
  // never reached this fallback (#2544).
  if (normalized.startsWith('agentic/code/agents/') || normalized.includes('/agentic/code/agents/')) return 4;
  if (normalized.includes('/plugins/') || normalized.startsWith('agentic/code/plugins/')) return 3;
  if (
    normalized.includes('/frameworks/') ||
    normalized.includes('/addons/') ||
    normalized.includes('/extensions/') ||
    normalized.startsWith('agentic/code/frameworks/') ||
    normalized.startsWith('agentic/code/addons/') ||
    normalized.startsWith('agentic/code/extensions/')
  ) {
    return 2;
  }
  return 1;
}

type ProvenancedEntry = MetadataEntry & {
  indexGraph?: string;
  indexScope?: 'project' | 'user' | 'packaged' | 'codebase' | 'custom';
};

function graphScope(graph: GraphType): ProvenancedEntry['indexScope'] {
  if (graph === 'project') return 'project';
  if (graph === 'user' || graph.startsWith('user-')) return 'user';
  if (graph === 'framework') return 'packaged';
  if (graph === 'codebase' || graph === 'source') return 'codebase';
  return 'custom';
}

function containsTokenSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function withIndexProvenance(entry: MetadataEntry, graph: GraphType): ProvenancedEntry {
  return { ...entry, indexGraph: graph, indexScope: graphScope(graph) };
}

/** Keep existing project capabilities visible while their derived cache is unavailable. */
function projectCapabilityFallback(cwd: string): MetadataEntry[] | null {
  const index = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', 'project');
  if (index) {
    const entries = Object.values(index.entries).map((entry) => withIndexProvenance(entry, 'project'));
    if (entries.length > 0) {
      // One diagnostic per command, on stderr so JSON and skill bodies stay parseable.
      console.error('Warning: project capability cache is unavailable or stale; using the local project index. Run `aiwg index sync` to repair the cache.');
      return entries;
    }
  }
  if (['extensions', 'addons', 'frameworks', 'plugins', 'skills'].some(
    (dir) => fs.existsSync(projectAiwgPath(cwd, dir)),
  )) {
    console.error('Warning: project capabilities could not be loaded: the cache is unavailable and the local project index is missing or empty. Run `aiwg index build --graph project` to repair discovery.');
  }
  return index ? [] : null;
}

function discoveryIdForEntry(entry: MetadataEntry): string {
  return stableRecordId(recordTypeForEntry(entry, 'v2'), entry.path);
}

function logicalDiscoverKey(entry: MetadataEntry): string {
  const identity = (entry.name ?? entry.title ?? path.basename(entry.path))
    .toLowerCase()
    .replace(/[-_\s]+/g, ' ')
    .trim();
  return `${entry.type}:${identity}`;
}

function dedupeDiscoverResults<T extends QueryResult>(results: T[]): T[] {
  const bestByIdentity = new Map<string, T>();
  for (const result of results) {
    const key = logicalDiscoverKey(result.entry);
    const existing = bestByIdentity.get(key);
    if (!existing || compareDiscoverResults(result, existing) < 0) {
      bestByIdentity.set(key, result);
    }
  }
  return Array.from(bestByIdentity.values()).sort(compareDiscoverResults);
}

function scopeRank(entry: MetadataEntry): number {
  const scope = (entry as ProvenancedEntry).indexScope;
  if (scope === 'project') return 0;
  if (scope === 'user') return 1;
  if (scope === 'custom') return 2;
  if (scope === 'packaged') return 3;
  if (scope === 'codebase') return 4;
  return canonicalLocalityRank(entry.path);
}

function compareText(left: string | undefined, right: string | undefined): number {
  return (left ?? '').localeCompare(right ?? '');
}

export function compareDiscoverResults(left: QueryResult, right: QueryResult): number {
  const scoreCmp = right.score - left.score;
  if (scoreCmp !== 0) return scoreCmp;

  const localityCmp = scopeRank(left.entry) - scopeRank(right.entry);
  if (localityCmp !== 0) return localityCmp;

  const typeCmp =
    (DISCOVER_TYPE_ORDER.get(left.entry.type) ?? 99) -
    (DISCOVER_TYPE_ORDER.get(right.entry.type) ?? 99);
  if (typeCmp !== 0) return typeCmp;

  const nameCmp = compareText(left.entry.name ?? left.entry.title, right.entry.name ?? right.entry.title);
  if (nameCmp !== 0) return nameCmp;

  return left.entry.path.localeCompare(right.entry.path);
}

/**
 * Stop-words to drop when tokenizing a discovery phrase. Keep short —
 * we want the user's verbs and nouns to dominate scoring.
 */
// Stopwords stripped from a discover QUERY before scoring (#1581). Two classes:
//   1. Grammatical filler (articles, prepositions, pronouns, question words,
//      asking verbs) — a natural-language intent like "Find an AIWG skill that
//      handles intake forms" carries the same meaning as "intake forms", but the
//      filler tokens inflate the token count: the strict overlap gate is
//      ceil(n/2), so a verbose query raises the bar above what the genuinely
//      relevant short-match artifact can clear, and the (hits/n) term dilutes
//      every score. Dropping filler collapses the query to its content tokens.
//   2. AIWG meta-type nouns ('aiwg', 'skill', 'agent', 'command', 'rule',
//      'flow', 'workflow') — in a discover query these carry zero discriminating
//      signal (every result IS an aiwg skill/agent/…; the TYPE is filtered via
//      --type). The content word after them is what matters
//      ("…skill that handles >intake forms<"). Keeping them surfaces incidental
//      junk matches (any artifact mentioning "skill"/"aiwg") above the real one.
// Only the query is tokenized here — entry fields are substring-matched — so this
// never changes what text an artifact exposes, only how the query is reduced.
const SCORE_STOPWORDS = new Set([
  // articles / conjunctions / prepositions / copula
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on',
  'with', 'into', 'from', 'is', 'are', 'be', 'i', 'we', 'my',
  // pronouns / determiners / fillers
  'it', 'you', 'me', 'us', 'your', 'our', 'this', 'that', 'these', 'those',
  'there', 'here', 'some', 'any', 'all', 'also', 'please', 'about', 'project',
  // question words
  'how', 'what', 'which', 'where', 'when', 'who', 'why',
  // asking / request verbs ("find a skill that handles …")
  'find', 'give', 'show', 'need', 'want', 'looking', 'look', 'help',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will',
  'handle', 'handles', 'handling',
  // AIWG meta-type nouns — zero discriminating signal in a discover query
  'aiwg', 'skill', 'skills', 'agent', 'agents', 'command', 'commands',
  'rule', 'rules', 'schema', 'schemas', 'flow', 'flows', 'workflow', 'workflows',
  'template', 'templates',
]);

/**
 * Tokenize a query phrase into lowercased keywords for multi-word
 * scoring. Splits on whitespace and punctuation; drops stopwords and
 * single-character tokens.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !SCORE_STOPWORDS.has(t))
    .map(token => token.length > 4 && token.endsWith('s') && !token.endsWith('ss')
      ? token.slice(0, -1)
      : token);
}

function matchedFieldTokens(queryTokens: string[], field: string): string[] {
  const fieldTokens = new Set(tokenize(field));
  return queryTokens.filter(token => fieldTokens.has(token));
}

function fieldContainsQuery(field: string, queryTokens: string[]): boolean {
  return containsTokenSequence(tokenize(field), queryTokens);
}

/**
 * Score a metadata entry against a keyword query.
 *
 * Multi-word queries are tokenized; each token contributes its weighted
 * match across the entry's searchable fields. The full phrase still
 * earns bonus weight when it appears as a contiguous substring or as
 * an exact trigger phrase (the most reliable signal).
 *
 * For AIWG artifact kinds (skills/agents/commands/rules) the entry
 * carries `triggers` (declared activation phrases) and `capability`
 * (one-line description). These get the highest weights so capability
 * search via `aiwg index discover` ranks the right skill on top
 * instead of bottoming out on a path-substring match (#1214).
 */
/**
 * Normalize a string for exact-name comparison (#1233) — lowercase and
 * collapse `-` / `_` / whitespace runs so hyphenated kernel-skill names
 * like `aiwg-doctor` match queries with spaces ("aiwg doctor") and the
 * rendered title ("AIWG Doctor") matches the slug query.
 */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[-_\s]+/g, ' ').trim();
}

function damerauLevenshteinAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;

  if (a.length === b.length) {
    let firstDiff = -1;
    let diffCount = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        if (firstDiff < 0) firstDiff = i;
        diffCount++;
      }
    }
    if (diffCount === 1) return true;
    return diffCount === 2
      && firstDiff + 1 < a.length
      && a[firstDiff] === b[firstDiff + 1]
      && a[firstDiff + 1] === b[firstDiff];
  }

  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
    } else {
      edits++;
      if (edits > 1) return false;
      j++;
    }
  }
  return true;
}

function nearNameMatch(query: string, name: string): boolean {
  const queryParts = normalizeName(query).split(/\s+/).filter(Boolean);
  const nameParts = normalizeName(name).split(/\s+/).filter(Boolean);
  if (queryParts.length !== nameParts.length) return false;

  return queryParts.every((part, i) => {
    const target = nameParts[i];
    if (part === target) return true;
    if (part.length < 5 || target.length < 5) return false;
    return damerauLevenshteinAtMostOne(part, target);
  });
}

interface LexicalMatchDiagnostic {
  field: 'name' | 'trigger' | 'capability' | 'title' | 'tag' | 'search_terms' | 'kind' | 'source_type' | 'summary' | 'path' | 'type';
  match: 'exact' | 'near-name' | 'contained-phrase' | 'token-overlap';
  value?: string;
  contribution: number;
  matched_tokens?: string[];
  query_token_coverage?: number;
}

interface LexicalScoreDiagnostic {
  content_tokens: string[];
  raw_score: number;
  score: number;
  score_cap_applied: boolean;
  matches: LexicalMatchDiagnostic[];
}

interface DetailedScore {
  score: number;
  diagnostic: LexicalScoreDiagnostic;
}

function scoreEntryDetailed(
  entry: MetadataEntry,
  text: string,
  opts: { relaxOverlap?: boolean } = {},
): DetailedScore {
  const tokens = tokenize(text);
  // Field substring matching uses the stopword-stripped CONTENT phrase, not the
  // raw query (#1581). Without this, a query that reduces to a single content
  // token — e.g. "intake skill" or "find an intake skill" → ["intake"] — sets
  // useMultiToken=false (1 token) and then fails the full-string `.includes()`
  // checks because the raw phrase ("intake skill") isn't a substring of any
  // field, while the one meaningful token is never matched. Joining the content
  // tokens restores the invariant that a single content token IS the phrase, and
  // for multi-token queries gives a tighter (content-only) phrase to match.
  // Pure-stopword queries fall back to the raw text.
  const lower = tokens.length > 0 ? tokens.join(' ') : text.toLowerCase().trim();
  const rawLower = text.toLowerCase().trim();
  const personaIdentitySuppressed = diagnoseFacetActivations(text).some(
    (activation) =>
      activation.facet === 'persona-identity' && activation.status === 'suppressed',
  );
  let score = 0;
  const matches: LexicalMatchDiagnostic[] = [];
  const creditedTokens = new Set<string>();
  const finish = (uncappedScore = score, cap = 1): DetailedScore => ({
    score: Math.min(uncappedScore, cap),
    diagnostic: {
      content_tokens: tokens,
      raw_score: uncappedScore,
      score: Math.min(uncappedScore, cap),
      score_cap_applied: uncappedScore > cap,
      matches,
    },
  });
  const addMatch = (
    contribution: number,
    match: Omit<LexicalMatchDiagnostic, 'contribution'>,
  ): void => {
    score += contribution;
    matches.push({ ...match, contribution });
  };
  const addTokenMatch = (
    contributionPerToken: number,
    hits: string[],
    match: Omit<LexicalMatchDiagnostic, 'contribution' | 'matched_tokens' | 'query_token_coverage'>,
  ): void => {
    const newlyMatched = hits.filter(token => !creditedTokens.has(token));
    if (newlyMatched.length === 0) return;
    newlyMatched.forEach(token => creditedTokens.add(token));
    addMatch(contributionPerToken * newlyMatched.length, {
      ...match,
      matched_tokens: newlyMatched,
      query_token_coverage: tokens.length > 0 ? newlyMatched.length / tokens.length : 0,
    });
  };

  // Exact-name floor (#1233) — if the query (normalized) exactly matches
  // the entry's canonical name, this is the artifact the user is asking
  // for and it must surface at the top regardless of how cluttered the
  // rest of the corpus scoring gets. Hyphens, underscores, and whitespace
  // are interchangeable in the comparison so `aiwg-doctor`, `aiwg doctor`,
  // and `aiwg_doctor` all match a kernel skill with `name: aiwg-doctor`.
  //
  // Returns 1.001 (not 1.0) so an exact-name hit sorts above the many
  // capped-at-1.0 substring matches that share generic words like "use".
  // Display rounding (Math.round(score * 100) / 100) hides the offset, so
  // the user still sees `score: 1.0` while sort order is preserved.
  if (entry.name) {
    const queryNorm = normalizeName(text);
    const nameNorm = normalizeName(entry.name);
    if (queryNorm === nameNorm) {
      matches.push({
        field: 'name',
        match: 'exact',
        value: entry.name,
        contribution: 1.001,
        matched_tokens: tokens,
        query_token_coverage: 1,
      });
      return finish(1.001, 1.001);
    }
    if (nearNameMatch(text, entry.name)) {
      matches.push({
        field: 'name',
        match: 'near-name',
        value: entry.name,
        contribution: 0.951,
        matched_tokens: tokens,
        query_token_coverage: 1,
      });
      return finish(0.951);
    }
  }

  // Searchable text — joined once so per-token includes() is cheap
  const titleLower = entry.title.toLowerCase();
  const summaryLower = entry.summary.toLowerCase();
  const pathLower = entry.path.toLowerCase();
  const typeLower = entry.type.toLowerCase();
  const capabilityLower = entry.capability ? entry.capability.toLowerCase() : '';
  const tagsLower = entry.tags.map(t => t.toLowerCase());
  const triggersLower = (entry.triggers ?? []).map(trigger => trigger.toLowerCase());
  const searchTermsLower = (entry.searchTerms ?? []).join(' ').toLowerCase();
  const kindLower = entry.kind?.toLowerCase() ?? '';
  const sourceTypeLower = entry.sourceType?.toLowerCase() ?? '';

  // For multi-token queries, require ≥50% token overlap to count
  // partial matches. This keeps gibberish queries (e.g.,
  // `xyzzy_zzqwkjhg_42` after splitting on `_`) from surfacing
  // incidental single-token hits.
  const useMultiToken = tokens.length > 1;
  // #1561 — verbose natural-language queries (e.g. "skill that handles intake
  // forms") dilute the token hit ratio below the ceil(n/2) overlap gate and
  // dead-end to zero results. When the strict pass finds nothing, callers
  // re-score with `relaxOverlap` so a single meaningful token hit (intake /
  // forms) still surfaces ranked candidates instead of an empty set.
  const minHits = useMultiToken
    ? (opts.relaxOverlap ? 1 : Math.ceil(tokens.length / 2))
    : 1;
  const overlapOK = (hits: number): boolean => useMultiToken && hits >= minHits;

  // Trigger phrase match — highest weight (4x). Exact match on the full
  // phrase wins big; substring or token-overlap is still strong.
  if (triggersLower.length > 0) {
    for (const trigger of triggersLower) {
      const triggerTokens = tokenize(trigger);
      const matchedTokens = tokens.filter((token) => triggerTokens.includes(token));
      const queryCoverage = tokens.length > 0 ? matchedTokens.length / tokens.length : 0;
      if (trigger === lower || trigger === rawLower) {
        matches.push({
          field: 'trigger',
          match: 'exact',
          value: trigger,
          contribution: 1.0008,
          matched_tokens: matchedTokens,
          query_token_coverage: 1,
        });
        return finish(1.0008, 1.0008);
      } else if (
        containsTokenSequence(triggerTokens, tokens) ||
        containsTokenSequence(tokens, triggerTokens)
      ) {
        const triggerInsideQuery = containsTokenSequence(tokens, triggerTokens);
        const containedCoverage = triggerInsideQuery
          ? queryCoverage
          : triggerTokens.length > 0
            ? matchedTokens.length / triggerTokens.length
            : 0;
        // A complete multi-word trigger inside a noisier query is a strong
        // metadata signal. The ambiguous one-word `persona` trigger is
        // downweighted only when the facet classifier has identified buyer /
        // audience marketing context; distinctive one-word triggers such as
        // GRADE retain their established exact-trigger behavior (#1828).
        const suppressedGenericPersona =
          personaIdentitySuppressed &&
          triggerTokens.length === 1 &&
          triggerTokens[0] === 'persona' &&
          tokens.length > 1;
        const contribution = suppressedGenericPersona
          ? 0.24 * queryCoverage
          : triggerTokens.length > 1
            ? Math.min(1, 0.75 + 0.25 * containedCoverage)
            : 1;
        addMatch(contribution, {
          field: 'trigger',
          match: 'contained-phrase',
          value: trigger,
          matched_tokens: matchedTokens,
          query_token_coverage: queryCoverage,
        });
      } else if (useMultiToken) {
        const hits = matchedFieldTokens(tokens, trigger);
        if (overlapOK(hits.length)) {
          addTokenMatch(0.1 * 4, hits, {
            field: 'trigger',
            match: 'token-overlap',
            value: trigger,
          });
        }
      }
    }
  }

  // Capability description (2x weight) — full phrase first, then tokens
  if (capabilityLower) {
    if (fieldContainsQuery(capabilityLower, tokens)) {
      addMatch(0.2 * 2, {
        field: 'capability',
        match: 'contained-phrase',
        value: entry.capability,
      });
    } else if (useMultiToken) {
      const hits = matchedFieldTokens(tokens, capabilityLower);
      if (overlapOK(hits.length)) {
        addTokenMatch(0.1 * 2, hits, {
          field: 'capability',
          match: 'token-overlap',
          value: entry.capability,
        });
      }
    }
  }

  // Title (3x weight)
  if (fieldContainsQuery(titleLower, tokens)) {
    addMatch(0.3 * 3, {
      field: 'title',
      match: titleLower === lower ? 'exact' : 'contained-phrase',
      value: entry.title,
    });
    if (titleLower === lower) {
      addMatch(0.2, { field: 'title', match: 'exact', value: entry.title });
    }
  } else if (useMultiToken) {
    const hits = matchedFieldTokens(tokens, titleLower);
    if (overlapOK(hits.length)) {
      addTokenMatch(0.08 * 3, hits, {
        field: 'title',
        match: 'token-overlap',
        value: entry.title,
      });
    }
  }

  // Tags (2x weight)
  for (const tag of tagsLower) {
    if (fieldContainsQuery(tag, tokens)) {
      addMatch(0.2 * 2, { field: 'tag', match: 'contained-phrase', value: tag });
    } else if (useMultiToken) {
      const hits = matchedFieldTokens(tokens, tag);
      if (overlapOK(hits.length)) {
        addTokenMatch(0.05 * 2, hits, {
          field: 'tag',
          match: 'token-overlap',
          value: tag,
        });
      }
    }
  }

  // Structure-aware language terms (1.5x weight). These are deliberately
  // below declared triggers/capabilities but above generic body summaries.
  if (fieldContainsQuery(searchTermsLower, tokens)) {
    addMatch(0.18 * 1.5, { field: 'search_terms', match: 'contained-phrase' });
  } else if (useMultiToken) {
    const hits = matchedFieldTokens(tokens, searchTermsLower);
    if (overlapOK(hits.length)) {
      addTokenMatch(0.06 * 1.5, hits, {
        field: 'search_terms',
        match: 'token-overlap',
      });
    }
  }

  // Exact declarative kind and physical source classification are compact,
  // useful routing signals (e.g. FlowPlaybook vs OpsInventory; runbook that
  // originated under templates/).
  if (fieldContainsQuery(kindLower, tokens)) {
    addMatch(0.15, { field: 'kind', match: 'contained-phrase', value: entry.kind });
  }
  if (fieldContainsQuery(sourceTypeLower, tokens)) {
    addMatch(0.08, { field: 'source_type', match: 'contained-phrase', value: entry.sourceType });
  }

  // Summary (1x weight)
  if (fieldContainsQuery(summaryLower, tokens)) {
    addMatch(0.15, { field: 'summary', match: 'contained-phrase' });
  } else if (useMultiToken) {
    const hits = matchedFieldTokens(tokens, summaryLower);
    if (overlapOK(hits.length)) {
      addTokenMatch(0.04, hits, {
        field: 'summary',
        match: 'token-overlap',
      });
    }
  }

  // Path (0.5x weight)
  if (fieldContainsQuery(pathLower, tokens)) {
    addMatch(0.1, { field: 'path', match: 'contained-phrase', value: entry.path });
  } else if (useMultiToken) {
    const hits = matchedFieldTokens(tokens, pathLower);
    if (overlapOK(hits.length)) {
      addTokenMatch(0.03, hits, {
        field: 'path',
        match: 'token-overlap',
        value: entry.path,
      });
    }
  }

  // Type (0.5x weight)
  if (fieldContainsQuery(typeLower, tokens)) {
    addMatch(0.1, { field: 'type', match: 'contained-phrase', value: entry.type });
  }

  return finish();
}

function scoreEntry(entry: MetadataEntry, text: string, opts: { relaxOverlap?: boolean } = {}): number {
  return scoreEntryDetailed(entry, text, opts).score;
}

/**
 * Query the artifact index
 */
export async function queryIndex(
  cwd: string,
  params: QueryParams,
  options: QueryOptions = {}
): Promise<void> {
  const { graph } = options;
  const backend = options.backend ?? DEFAULT_ARTIFACT_SEARCH_BACKEND;
  const startTime = Date.now();

  let candidates: MetadataEntry[];

  if (backend === 'fortemi-core') {
    const { loadFortemiCoreMetadataEntries } = await import('./fortemi-core-query-adapter.js');
    const loaded = loadFortemiCoreMetadataEntries(cwd, graph ?? 'project');
    if (loaded.reason) {
      if (options.json) {
        console.log(JSON.stringify({
          query: { text: params.text, backend: 'fortemi-core', graph: graph ?? 'project' },
          results: [],
          total: 0,
          hint: loaded.reason ?? 'Fortemi Core static index is unavailable.',
        }, null, 2));
      } else {
        console.error('Error: ' + (loaded.reason ?? 'Fortemi Core static index is unavailable.'));
      }
      process.exit(1);
    }
    candidates = loaded.entries;
  } else if (graph) {
    // Single graph mode
    const index = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', graph);
    if (!index) {
      console.error(`Error: No artifact index found for graph '${graph}'.`);
      console.log("Run 'aiwg index build' first to create the index.");
      process.exit(1);
    }
    candidates = Object.values(index.entries);
  } else {
    // No graph specified: search across all project-local graphs
    const graphTypes: GraphType[] = ['project', 'codebase'];
    const allEntries: MetadataEntry[] = [];
    for (const g of graphTypes) {
      const idx = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', g);
      if (idx) allEntries.push(...Object.values(idx.entries));
    }

    // Fall back to legacy root index
    if (allEntries.length === 0) {
      const legacy = loadMetadataIndex(cwd);
      if (!legacy) {
        console.error('Error: No artifact index found.');
        console.log("Run 'aiwg index build' first to create the index.");
        process.exit(1);
      }
      allEntries.push(...Object.values(legacy.entries));
    }

    candidates = allEntries;
  }

  // Apply filters
  if (params.type) {
    candidates = candidates.filter(e => e.type === params.type);
  }
  if (params.phase) {
    candidates = candidates.filter(e => e.phase === params.phase);
  }
  if (params.tags && params.tags.length > 0) {
    candidates = candidates.filter(e =>
      params.tags!.every(tag => e.tags.includes(tag))
    );
  }
  if (params.path) {
    candidates = candidates.filter(e => minimatch(e.path, params.path!));
  }
  if (params.updatedAfter) {
    const cutoff = new Date(params.updatedAfter).getTime();
    candidates = candidates.filter(e => new Date(e.updated).getTime() >= cutoff);
  }

  // Score and rank
  let results: QueryResult[];
  const matchedById = new Map<string, string[]>();
  const operationalStateById = new Map<string, OperationalStateQueryProjection>();
  if (params.text && params.fulltext && backend === 'fortemi-core') {
    const { queryFortemiCoreStaticFulltextIndex } = await import('./fortemi-core-query-adapter.js');
    const queried = queryFortemiCoreStaticFulltextIndex(cwd, {
      graph: graph ?? 'project',
      text: params.text,
      limit: params.limit ?? 20,
      path: params.path,
      type: params.type,
      phase: params.phase,
      tags: params.tags,
    });
    if (queried.reason) {
      if (options.json) {
        console.log(JSON.stringify({
          query: { text: params.text, backend: 'fortemi-core', graph: graph ?? 'project' },
          mode: 'fulltext',
          results: [],
          total: 0,
          hint: queried.reason,
        }, null, 2));
      } else {
        console.error('Error: ' + queried.reason);
      }
      process.exit(1);
    }
    results = queried.results.map(result => {
      const entry: MetadataEntry = {
        path: result.path,
        type: result.type,
        phase: result.phase,
        title: result.title,
        tags: result.tags,
        created: '',
        updated: '',
        checksum: '',
        summary: result.summary,
        dependencies: [],
        dependents: [],
      };
      matchedById.set(result.path, result.matched);
      if (result.operational_state) {
        operationalStateById.set(result.path, result.operational_state);
      }
      return { entry, score: result.score };
    });
  } else if (params.text && params.fulltext) {
    // Lexical full-text (#1494): read candidate bodies and BM25-rank. The
    // index is the candidate set; ranking is over actual body content, not
    // the metadata/summary the default path scores.
    const byPath = new Map<string, MetadataEntry>();
    const docs: FullTextDoc[] = [];
    for (const entry of candidates) {
      const body = readEntryBody(cwd, entry.path);
      if (body === null) continue;
      byPath.set(entry.path, entry);
      docs.push({ id: entry.path, text: body });
    }
    const hits = bm25Rank(docs, params.text);
    results = hits
      .map(h => {
        matchedById.set(h.id, h.matchedTerms);
        return { entry: byPath.get(h.id)!, score: h.score };
      })
      .filter(r => r.entry);
  } else if (params.text) {
    results = candidates
      .map(entry => ({ entry, score: scoreEntry(entry, params.text!) }))
      .filter(r => r.score > 0)
      .sort(compareDiscoverResults);
  } else {
    // No keyword — return all filtered results with score 1.0
    results = candidates.map(entry => ({ entry, score: 1.0 }));
  }

  // Apply limit
  const limit = params.limit ?? 20;
  results = results.slice(0, limit);

  const queryTimeMs = Date.now() - startTime;

  // Output
  if (options.json) {
    console.log(JSON.stringify({
      query: { text: params.text, filters: { type: params.type, phase: params.phase, tags: params.tags, path: params.path }, backend },
      mode: params.fulltext ? 'fulltext' : 'metadata',
      results: results.map(r => ({
        path: r.entry.path,
        type: r.entry.type,
        phase: r.entry.phase,
        title: r.entry.title,
        score: Math.round(r.score * 100) / 100,
        summary: r.entry.summary,
        ...(operationalStateById.has(r.entry.path)
          ? { operational_state: operationalStateById.get(r.entry.path) }
          : r.entry.operationalState
            ? { operational_state: operationalStateQueryProjection(r.entry.operationalState) }
            : {}),
        ...(params.fulltext ? { matched: matchedById.get(r.entry.path) ?? [] } : {}),
      })),
      total: results.length,
      query_time_ms: queryTimeMs,
    }, null, 2));
  } else {
    const queryDesc = params.text ? `"${params.text}"` : 'all';
    console.log(`Results for ${queryDesc} (${results.length} matches, ${queryTimeMs}ms):`);
    console.log('');
    console.log('  #  Score  Type         Phase          Path');

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const num = String(i + 1).padStart(3);
      const score = r.score.toFixed(2).padStart(4);
      const type = r.entry.type.padEnd(12).slice(0, 12);
      const phase = r.entry.phase.padEnd(14).slice(0, 14);
      console.log(`  ${num}  ${score}  ${type} ${phase} ${r.entry.path}`);
    }

    if (results.length === 0) {
      console.log('  No results found.');
    }
    console.log('');
  }
}

/**
 * Discovery query — capability search across AIWG artifact kinds.
 *
 * Tuned for "agent looking for the right operational asset" use case.
 * Defaults the type filter to AIWG operational artifact kinds, prefers the
 * `framework` graph (where deployed source lives), and outputs in a
 * token-tight format that names the top trigger phrase responsible for
 * each match.
 *
 * @implements #1214
 */
export interface DiscoverParams {
  /** Trusted host-only, default-off D27 observer. Shadow evidence never changes ranking. */
  shadowRoute?: DiscoveryShadowRoute;
  /** Search phrase (the user's capability description) */
  phrase: string;
  /** Restrict to specific types — defaults to the operational discovery surface */
  typeFilter?: string[];
  /** Max results (default 10) */
  limit?: number;
  /** JSON output mode */
  json?: boolean;
  /** Pretty-print JSON output. Defaults to true for CLI compatibility. */
  jsonPretty?: boolean;
  /** Override default graph (defaults to `framework`, falls back to `project`) */
  graph?: GraphType;
  /** Query backend. Defaults to Fortemi Core; use local for the legacy path. */
  backend?: 'local' | 'fortemi-core';
  /** Physical source of AIWG-owned resources. Defaults to local. */
  resourceSource?: ResourceSource;
  /** Exact calendar-semver version or signed channel selector for web mode. */
  aiwgVersion?: string;
  /** Prohibit network requests and require a fully verified warm cache. */
  offline?: boolean;
  /** Dependency injection for release-host tests and development. */
  webReleaseOptions?: Omit<WebReleaseOptions, 'selector' | 'offline'>;
  /**
   * Include filesystem paths in public discovery output. Default is true for
   * direct API compatibility; CLI callers set false so discover stays
   * capability-oriented and agents use the stable id with `show metadata`.
   */
  includePaths?: boolean;
}

const DEFAULT_DISCOVER_TYPES = [...OPERATIONAL_DISCOVERY_TYPES];

const DEFAULT_CAPABILITY_GRAPHS: GraphType[] = ['project', 'user', 'framework'];

function projectAllowsUserIndices(cwd: string): boolean {
  try {
    const configPath = projectControlPath(cwd, 'aiwg.config');
    if (!fs.existsSync(configPath)) return true;
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const index = parsed.index as Record<string, unknown> | undefined;
    const userIndices = index?.userIndices as Record<string, unknown> | undefined;
    if (userIndices?.enabled === false) return false;
    const indices = parsed.indices as Record<string, unknown> | undefined;
    const user = indices?.user as Record<string, unknown> | undefined;
    if (user?.enabled === false) return false;
  } catch {
    return true;
  }
  return true;
}

function defaultCapabilityGraphs(cwd: string): GraphType[] {
  if (projectAllowsUserIndices(cwd)) return DEFAULT_CAPABILITY_GRAPHS;
  return DEFAULT_CAPABILITY_GRAPHS.filter((graph) => graph !== 'user' && !graph.startsWith('user-'));
}

/**
 * Resolve the AIWG installation root for path-anchoring discover output.
 * Discover returns paths anchored to AIWG_ROOT so the agent's `Read`
 * tool can resolve them from any project working directory (#1217).
 */
/**
 * Build the `run_hint` string for a script-bearing skill entry (#1227).
 *
 * Format: `aiwg run skill <name> [-- <argsHint>]`. The skill name is the
 * basename of its source directory (skills/<name>/SKILL.md), which is
 * what `aiwg run skill` accepts.
 */
function buildRunHint(entry: MetadataEntry): string {
  // Use the directory basename for slug-layout skills, filename stem otherwise.
  const lastSlash = entry.path.lastIndexOf('/');
  const tail = lastSlash >= 0 ? entry.path.slice(lastSlash + 1) : entry.path;
  let name: string;
  if (tail === 'SKILL.md' && lastSlash >= 0) {
    const dir = entry.path.slice(0, lastSlash);
    const dirSlash = dir.lastIndexOf('/');
    name = dirSlash >= 0 ? dir.slice(dirSlash + 1) : dir;
  } else {
    name = tail.replace(/\.[^.]+$/, '');
  }
  const argsHint = entry.script?.argsHint ? ` -- ${entry.script.argsHint}` : '';
  return `aiwg run skill ${name}${argsHint}`;
}

function showHintForDiscoverResult(entry: MetadataEntry, id: string): string {
  if (isOperationalShowType(entry.type)) {
    return `aiwg show ${entry.type} ${id}`;
  }
  return `aiwg show ${id}`;
}

export async function discoverCapability(
  cwd: string,
  params: DiscoverParams,
): Promise<void> {
  loadGlobalGraphConfigs();
  const startTime = Date.now();
  const types = params.typeFilter && params.typeFilter.length > 0
    ? params.typeFilter
    : DEFAULT_DISCOVER_TYPES;
  // Default top-K = 5 (Wave A from #1218): peer-reviewed work on tool
  // retrieval (Semantic Tool Discovery for MCP, arXiv:2603.20313) reports
  // 97.1% hit@K=3 at scale; K=5 keeps a buffer above K=3 while halving
  // the prior K=10 default. Operators wanting more breadth can pass
  // `--limit N` explicitly.
  const limit = params.limit ?? 5;
  // For framework-graph entries, anchor returned paths to AIWG_ROOT so
  // they resolve from any project working directory (#1217).
  const aiwgRoot = resolveFrameworkIndexRoot(cwd);

  // Source: prefer `framework` graph (built post-deploy), fall back to
  // project / codebase / legacy depending on what's available.
  let entries: MetadataEntry[] = [];
  const backend = params.backend ?? DEFAULT_ARTIFACT_SEARCH_BACKEND;
  let fortemiCoreDiscoveryScores: Map<string, number> | null = null;
  let resourceSource: ResourceSource = params.resourceSource ?? 'local';
  let resolvedWebRelease: VerifiedWebRelease | undefined;
  let verifiedSourcePaths:
    | import('./fortemi-core-query-adapter.js').FortemiCoreVerifiedSourcePaths
    | undefined;

  const prebuiltRelations = resourceSource !== 'web' && (!params.graph || params.graph === 'framework')
    ? selectPrebuiltRelations(cwd).reader : null;

  if ((!prebuiltRelations || backend === 'local') && resourceSource !== 'web' && (!params.graph || params.graph === 'framework')) {
    const root = resolveFrameworkCorpusRoot(cwd) ?? aiwgRoot;
    if (root) {
      try {
        await refreshFrameworkCapabilities(root, backend === 'fortemi-core');
      } catch (error) {
        console.error(`Warning: capability index refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (resourceSource === 'auto') {
    const { loadFortemiCoreMetadataEntries } = await import('./fortemi-core-query-adapter.js');
    const localGraphs = params.graph ? [params.graph] : defaultCapabilityGraphs(cwd);
    const localAvailable = localGraphs.some(
      (graph) => loadFortemiCoreMetadataEntries(cwd, graph).entries.length > 0
        || Object.keys(loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', graph)?.entries ?? {}).length > 0,
    );
    resourceSource = localAvailable ? 'local' : 'web';
  }

  if (resourceSource === 'web') {
    if (backend !== 'fortemi-core') {
      console.error('Error: --resource-source web requires the Fortemi Core query backend; --backend local remains available with local resources.');
      process.exit(1);
    }
    if (params.graph && params.graph !== 'framework') {
      console.error("Error: web-backed capability discovery currently supports only the 'framework' graph.");
      process.exit(1);
    }
    try {
      const { resolveWebRelease } = await import('../resources/web-release.js');
      const release = await resolveWebRelease({
        ...params.webReleaseOptions,
        selector: params.aiwgVersion ?? 'stable',
        offline: params.offline,
      });
      resolvedWebRelease = release;
      verifiedSourcePaths = {
        manifestPath: release.fortemiManifestPath,
        exportPath: release.fortemiExportPath,
        manifestSha256: release.fortemiManifestSha256,
        manifestSize: release.fortemiManifestSize,
        exportSha256: release.fortemiExportSha256,
        exportSize: release.fortemiExportSize,
      };
    } catch (error) {
      console.error(`Error: AIWG web resource resolution failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  if (backend === 'fortemi-core') {
    const graphs = resourceSource === 'web'
      ? ['framework' as GraphType]
      : params.graph ? [params.graph] : defaultCapabilityGraphs(cwd);
    const {
      loadFortemiCoreMetadataEntries,
      queryFortemiCoreAiwgDiscovery,
    } = await import('./fortemi-core-query-adapter.js');
    let unavailableReason: string | undefined;
    for (const graph of graphs) {
      const loaded = loadFortemiCoreMetadataEntries(cwd, graph, verifiedSourcePaths);
      if (loaded.reason && graph === 'project' && !params.graph) {
        const fallback = projectCapabilityFallback(cwd);
        if (fallback) {
          entries.push(...fallback);
          continue;
        }
      }
      if (loaded.sourceIndexNewer && resourceSource === 'local') {
        // Do not silently omit a graph whose derived cache is stale. Rank its
        // current source metadata, without consulting scores from the old cache.
        const index = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', graph);
        if (index) {
          console.error(`Warning: ${graph} capability cache is unavailable or stale; using the local ${graph} index. ${loaded.reason}`);
          entries.push(...Object.values(index.entries).map((entry) => withIndexProvenance(entry, graph)));
          continue;
        }
      }
      if (loaded.reason) {
        unavailableReason ??= loaded.reason;
        if (graph === 'framework' && !params.graph) {
          console.error(`Warning: framework capabilities are unavailable: ${loaded.reason}`);
        }
      }
      entries.push(...loaded.entries.map((entry) => withIndexProvenance(entry, graph)));
      const discovered = await queryFortemiCoreAiwgDiscovery(cwd, {
        graph,
        text: params.phrase,
        limit: Math.max(limit * 10, 50),
        types,
        sourcePaths: verifiedSourcePaths,
      });
      if (!discovered.reason) {
        fortemiCoreDiscoveryScores ??= new Map();
        for (const result of discovered.results) {
          if (result.score <= 0) continue;
          fortemiCoreDiscoveryScores.set(
            result.entry.path,
            Math.max(fortemiCoreDiscoveryScores.get(result.entry.path) ?? 0, result.score),
          );
        }
      }
    }
    if (entries.length === 0 && unavailableReason) {
      if (params.json) {
        console.log(JSON.stringify({
          query: {
            phrase: params.phrase,
            types,
            limit,
            backend: 'fortemi-core',
            graph: resourceSource === 'web' ? 'framework' : params.graph ?? 'capability-default',
            ...(resourceSource === 'web'
              ? {
                  resource_source: 'web',
                  aiwg_selector: resolvedWebRelease?.selector,
                  aiwg_version: resolvedWebRelease?.version,
                  manifest_sha256: resolvedWebRelease?.manifestDigest,
                  manifest_url: resolvedWebRelease?.manifestUrl,
                }
              : {}),
          },
          results: [],
          rule_stats: emptyRuleStats(),
          total: 0,
          hint: unavailableReason,
        }, null, 2));
      } else {
        console.error('Error: ' + unavailableReason);
      }
      process.exit(1);
    }
  } else if (params.graph) {
    const idx = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', params.graph);
    if (idx) entries = Object.values(idx.entries).map((entry) => withIndexProvenance(entry, params.graph!));
  } else {
    // discover is EXCLUSIVELY the agentic-capability surface (#1545): source
    // the `framework` graph (deployed AIWG capabilities) + project-local
    // capability artifacts. NEVER `codebase` — source code is not a capability
    // surface. The framework
    // index is reconciled with its source above, including existing indexes
    // left behind by an older runtime or a different checkout.
    const fwIdx = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', 'framework');
    const includeUser = projectAllowsUserIndices(cwd);
    // Project-local operational artifacts authored in this project. The
    // DEFAULT_DISCOVER_TYPES filter keeps non-capability project artifacts
    // (requirements, ADRs, …) out of results.
    const projIdx = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', 'project');
    if (projIdx) entries.push(...Object.values(projIdx.entries).map((entry) => withIndexProvenance(entry, 'project')));
    if (includeUser) {
      const userIdx = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', 'user');
      if (userIdx) entries.push(...Object.values(userIdx.entries).map((entry) => withIndexProvenance(entry, 'user')));
    }
    if (fwIdx) entries.push(...Object.values(fwIdx.entries).map((entry) => withIndexProvenance(entry, 'framework')));
    if (entries.length === 0) {
      const legacy = loadMetadataIndex(cwd);
      if (legacy) entries.push(...Object.values(legacy.entries));
    }
  }

  if (entries.length === 0 && backend !== 'fortemi-core') {
    // Empty-index case (#1221). Surface a hint that explains the gap rather
    // than returning a bare zero-result envelope — the latter trains agents
    // to conclude "AIWG doesn't have a skill for that" when in fact the
    // index simply hasn't been built in this workspace yet.
    const hint = 'No artifact index found. Run `aiwg index build --graph framework` (or `aiwg use <framework>`) first.';
    if (params.json) {
      console.log(JSON.stringify({
        query: { phrase: params.phrase, types },
        results: [],
        rule_stats: emptyRuleStats(),
        total: 0,
        hint,
      }, null, 2));
    } else {
      console.error('Error: No artifact index found.');
      console.log('Run `aiwg index build --graph framework` (or `aiwg use <framework>`) first.');
    }
    process.exit(1);
  }

  // Filter by type
  const candidates = entries.filter(e => types.includes(e.type));

  // Score (strict overlap gate). Keep the full sorted list so the facet
  // fusion below can inject/lift curated capabilities into the top-K before
  // truncation — a capability that the lexical pass ranked outside `limit`
  // (or missed entirely) still surfaces when the query activates its facet.
  const lexicalDiagnostics = new Map<string, LexicalScoreDiagnostic>();
  const legacyStrictScored = candidates
    .map(entry => {
      const detailed = scoreEntryDetailed(entry, params.phrase);
      const legacyScore = detailed.score;
      const fortemiScore = fortemiCoreDiscoveryScores?.get(entry.path) ?? 0;
      lexicalDiagnostics.set(entry.path, detailed.diagnostic);
      return {
        entry,
        score: legacyScore > 0 ? legacyScore : fortemiScore * 0.2,
        legacyScore,
      };
    })
    .filter(r => r.score > 0)
    .sort(compareDiscoverResults);
  const strictScored = (
    legacyStrictScored.some(result => result.legacyScore > 0)
      ? legacyStrictScored.filter(result => result.legacyScore > 0)
      : legacyStrictScored
  ).map(({ entry, score }) => ({ entry, score }));

  // Single-pass facet fusion (#1623 U3): fuse the curated feature→capability
  // facets (expansion / persona / project / provider-capability) into the
  // lexical ranking so canonical domain phrases rank their owning capability
  // top-K instead of being out-scored by artifacts that merely mention the
  // word. Facet activation can also rescue an otherwise-empty strict pass.
  // #154 — a strict result anywhere in the corpus must not suppress relevant
  // partial matches for a natural-language query. Score the relaxed pass on
  // matched terms (unmatched terms do not divide the score), apply a noise
  // floor, and union it with strict matches before ranking. Word-boundary
  // token matching keeps this from resurrecting substring noise such as UX in
  // Linux.
  const RELAXED_MIN_SCORE = 0.02;
  const strictPaths = new Set(strictScored.map(result => result.entry.path));
  const combinedByPath = new Map(strictScored.map(result => [result.entry.path, result]));
  for (const entry of candidates) {
    const detailed = scoreEntryDetailed(entry, params.phrase, { relaxOverlap: true });
    if (detailed.score < RELAXED_MIN_SCORE) continue;
    const existing = combinedByPath.get(entry.path);
    if (!existing || detailed.score > existing.score) {
      combinedByPath.set(entry.path, { entry, score: detailed.score });
      lexicalDiagnostics.set(entry.path, detailed.diagnostic);
    }
  }
  const scored = dedupeDiscoverResults(
    await applyFacetFusion(
      Array.from(combinedByPath.values()).sort(compareDiscoverResults),
      candidates,
      params.phrase,
    ),
  ).slice(0, limit);
  const relaxed = scored.some(result => !strictPaths.has(result.entry.path));

  if (params.shadowRoute) {
    try {
      await params.shadowRoute.observe(params.phrase, scored.map(result => ({
        id: discoveryIdForEntry(result.entry), name: result.entry.name ?? result.entry.title,
        type: result.entry.type, capability: result.entry.capability ?? result.entry.summary,
        score: result.score,
      })));
    } catch {
      // An optional observation failure must never replace deterministic discovery.
      params.shadowRoute.disable();
    }
  }

  const queryTimeMs = Date.now() - startTime;

  /**
   * Resolve a stored framework-graph path to an absolute AIWG_ROOT
   * path (#1217). Framework-graph entries are stored as paths relative
   * to the AIWG repo root (e.g. `agentic/code/frameworks/.../SKILL.md`);
   * anchoring them to `AIWG_ROOT` makes them readable from any project
   * working directory.
   *
   * Kernel skills are anchored the same way (#1230) — `aiwg show` reads
   * the source corpus, not platform deploy mirrors, so kernel entries
   * need the same `AIWG_ROOT` anchoring as non-kernel framework entries.
   * Non-framework entries (project / codebase graphs) keep their stored
   * paths unchanged.
   */
  function resolvePath(entry: MetadataEntry): string {
    const normalizedPath = normalizeIndexedPath(entry.path);
    if (!aiwgRoot) return normalizedPath;
    if (path.isAbsolute(entry.path)) return entry.path;
    if (normalizedPath.startsWith('agentic/code/')) return path.join(aiwgRoot, normalizedPath);
    return normalizedPath;
  }

  // Build a hint string when the index has entries but no scored matches —
  // this is the second silent-failure mode #1221 calls out. When the workspace
  // has project-local content (.aiwg/{extensions,addons,frameworks,plugins,providers}/)
  // surface a project-graph rebuild hint (#1235).
  // discover-appropriate hint (#1545): never push index/graph mechanics. If
  // nothing scored, the phrase didn't match an indexed capability — suggest a
  // broader phrase / type filter, and a capability refresh via `aiwg use`.
  const emptyResultHint = scored.length === 0
    ? backend === 'fortemi-core'
      ? `No capability matched "${params.phrase}" among ${entries.length} Fortemi Core static-cache capabilities. Try a broader phrase or a \`--type\` filter. If the local index changed, refresh the cache with \`aiwg index sync ${params.graph ? `--graph ${params.graph}` : '--all'}\`, or pass \`--backend local\` to use the legacy local index.`
      : `No capability matched "${params.phrase}" among ${entries.length} indexed capabilities. Try a broader phrase or a \`--type\` filter. If you just installed or authored capabilities, refresh discovery with \`aiwg use <framework>\` (or \`aiwg index build\`).`
    : null;

  const relations = resourceSource === 'local' && (!params.graph || params.graph === 'framework')
    ? prebuiltRelations ?? await ensureRelations(cwd) : undefined;
  const governing = scored.map(result => compoundGoverningRules(entries, result.entry, relations ?? undefined, params.phrase));
  const responseRules = new Map<string, GoverningRule>();
  for (const item of governing.flat()) {
    const key = `${item.rule.type}:${item.rule.path}`, prior = responseRules.get(key);
    responseRules.set(key, { rule: item.rule, applicability: [...new Set([...(prior?.applicability ?? []), ...item.applicability])] });
  }
  const responseFields = governingRuleFields([...responseRules.values()]);
  const responseRuleStats = governingRuleStats([...responseRules.values()]);
  const includePaths = params.includePaths ?? true;
  const facetActivations = diagnoseFacetActivations(params.phrase);
  const roundDiagnostic = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
  const rankingDiagnostic = (
    entry: MetadataEntry,
    finalScore: number,
    facetDiagnostics: FacetScoreDiagnostic[] | undefined,
  ) => {
    const lexical = lexicalDiagnostics.get(entry.path) ?? {
      content_tokens: tokenize(params.phrase),
      raw_score: 0,
      score: 0,
      score_cap_applied: false,
      matches: [],
    };
    const scope = (entry as ProvenancedEntry).indexScope ?? 'unknown';
    return {
      lexical_score: roundDiagnostic(lexical.score),
      lexical_raw_score: roundDiagnostic(lexical.raw_score),
      final_score: roundDiagnostic(finalScore),
      score_cap_applied: lexical.score_cap_applied,
      matches: lexical.matches.map((match) => ({
        ...match,
        contribution: roundDiagnostic(match.contribution),
        ...(match.query_token_coverage === undefined
          ? {}
          : { query_token_coverage: roundDiagnostic(match.query_token_coverage) }),
      })),
      facets: (facetDiagnostics ?? []).map((facet) => ({
        ...facet,
        activation_floor: roundDiagnostic(facet.activation_floor),
        base_score: roundDiagnostic(facet.base_score),
        rrf_tiebreak: roundDiagnostic(facet.rrf_tiebreak),
      })),
      tie_breakers: {
        scope,
        scope_rank: scopeRank(entry),
        type_rank: DISCOVER_TYPE_ORDER.get(entry.type) ?? 99,
      },
    };
  };

  const { loadRelations } = await import('./relations.js');
  const ruleRelations = resourceSource === 'local' ? loadRelations(cwd) ?? (aiwgRoot ? loadRelations(aiwgRoot, cwd) : null) : null;
  if (params.json) {
    const jsonIndent = params.jsonPretty === false ? undefined : 2;
    console.log(JSON.stringify({
      query: {
        phrase: params.phrase,
        types,
        limit,
        aiwg_root: aiwgRoot ?? null,
        backend,
        graph: backend === 'fortemi-core'
          ? resourceSource === 'web' ? 'framework' : params.graph ?? 'capability-default'
          : params.graph,
        ...(resourceSource === 'web'
          ? {
              resource_source: 'web',
              aiwg_selector: resolvedWebRelease?.selector,
              aiwg_version: resolvedWebRelease?.version,
              manifest_sha256: resolvedWebRelease?.manifestDigest,
              manifest_url: resolvedWebRelease?.manifestUrl,
            }
          : {}),
      },
      results: scored.map((r, resultIndex) => ({
        id: discoveryIdForEntry(r.entry),
        ...(includePaths ? { path: resolvePath(r.entry) } : {}),
        type: r.entry.type,
        name: r.entry.name,
        title: r.entry.title,
        score: Math.round(r.score * 100) / 100,
        ranking: rankingDiagnostic(r.entry, r.score, r.facetDiagnostics),
        ...governingRuleFields(governing[resultIndex]),
        triggers: r.entry.triggers ?? [],
        capability: r.entry.capability ?? r.entry.summary,
        kernel: r.entry.kernel ?? false,
        ...(['skill', 'agent', 'flow', 'command'].includes(r.entry.type) && ruleRelations
          && ruleRelations.rulesForTarget(r.entry.type as RelationTargetType, discoveryIdForEntry(r.entry)).length ? {
          startup_rule_stats: ruleRelations.ruleStats(r.entry.type as 'skill' | 'agent' | 'flow' | 'command', discoveryIdForEntry(r.entry)),
        } : {}),
        provenance: {
          graph: (r.entry as ProvenancedEntry).indexGraph ?? null,
          scope: (r.entry as ProvenancedEntry).indexScope ?? null,
        },
        // #1227 — surface script-bearing skills so agents know to use
        // `aiwg run skill <name>` instead of executing instructions
        // themselves.
        ...(r.entry.script
          ? {
              executable: true,
              run_hint: buildRunHint(r.entry),
            }
          : {}),
      })),
      rule_stats: responseRuleStats,
      ...(responseFields.required_rule_checks ? { required_rule_checks: responseFields.required_rule_checks, rule_check_obligation: RULE_CHECK_OBLIGATION } : {}),
      total: scored.length,
      query_time_ms: queryTimeMs,
      diagnostics: {
        content_tokens: tokenize(params.phrase),
        facet_activations: facetActivations,
        score_tie_break_order: ['score', 'scope', 'type', 'name', 'path'],
      },
      ...(relaxed ? { relaxed_overlap: true } : {}),
      ...(emptyResultHint ? { hint: emptyResultHint } : {}),
    }, null, jsonIndent));
    return;
  }

  if (scored.length === 0) {
    console.log(`No discovery matches for "${params.phrase}" in types: ${types.join(',')}.`);
    console.log(backend === 'fortemi-core'
      ? emptyResultHint
      : 'Try a broader phrase or a `--type` filter. If capabilities were just added, refresh with `aiwg use <framework>` (or `aiwg index build`).');
    return;
  }

  const relaxedNote = relaxed ? ' — relaxed match (verbose query)' : '';
  console.log(`Discovery results for "${params.phrase}" (${scored.length} matches, ${queryTimeMs}ms)${relaxedNote}:`);
  console.log(statsText(responseRuleStats));
  console.log('');
  for (const diagnostic of facetActivations) {
    if (diagnostic.status === 'suppressed' && diagnostic.reason) {
      console.log(`Routing diagnostic: ${diagnostic.reason}.`);
      console.log('');
    }
  }
  for (let i = 0; i < scored.length; i++) {
    const r = scored[i];
    const ranking = rankingDiagnostic(r.entry, r.score, r.facetDiagnostics);
    const id = discoveryIdForEntry(r.entry);
    const score = r.score.toFixed(2);
    const flags = [
      r.entry.kernel ? 'kernel' : null,
      r.entry.script ? 'exec' : null,
    ].filter(Boolean).join(', ');
    const locator = includePaths ? resolvePath(r.entry) : id;
    const topTriggerMatch = ranking.matches
      .filter((match) => match.field === 'trigger')
      .reduce<(typeof ranking.matches)[number] | undefined>(
        (best, match) => !best || match.contribution > best.contribution ? match : best,
        undefined,
      );
    const topTrigger = topTriggerMatch?.value ??
      (r.entry.triggers && r.entry.triggers.length > 0 ? r.entry.triggers[0] : '');
    console.log(`${i + 1}. ${r.entry.title}`);
    console.log(`   type: ${r.entry.type}  score: ${score}${flags ? `  flags: ${flags}` : ''}`);
    console.log(`   ${includePaths ? 'path' : 'id'}: ${locator}`);
    if (r.entry.name) {
      console.log(`   name: ${r.entry.name}`);
    }
    if (r.entry.capability) {
      console.log(`   capability: ${r.entry.capability}`);
    }
    if (topTrigger) {
      console.log(`   trigger: "${topTrigger}"`);
    }
    const triggerCoverage = topTriggerMatch?.query_token_coverage;
    const rankingParts = [
      `lexical ${ranking.lexical_score.toFixed(4)} -> final ${ranking.final_score.toFixed(4)}`,
      triggerCoverage === undefined
        ? null
        : `trigger covers ${Math.round(triggerCoverage * 100)}% of query tokens`,
      `scope ${ranking.tie_breakers.scope}`,
    ].filter((part): part is string => Boolean(part));
    console.log(`   ranking: ${rankingParts.join('; ')}`);
    if (governing[i].length) {
      console.log(`   ${statsText(governingRuleStats(governing[i]))}`);
      console.log(`   ${RULE_CHECK_OBLIGATION}`);
      for (const { rule, applicability } of governing[i]) console.log(`   - ${rule.name ?? rule.path}: ${rule.ruleSummary ?? ''} (${applicability.join('; ')}) — \`${boundRuleDescriptor(rule).show_command}\``);
    }
    if (r.entry.script) {
      console.log(`   run: ${buildRunHint(r.entry)}`);
    } else if (!includePaths) {
      console.log(`   show: ${showHintForDiscoverResult(r.entry, id)}`);
    }
    console.log('');
  }
  console.log('Use `--format json` for machine-readable output. Use `aiwg show metadata <id>` for paths and full metadata.');
}

export interface ShowParams {
  /** Skill name (e.g. `intake-wizard`), title, or artifact path */
  name: string;
  /** Restrict to specific types — defaults to showable operational types */
  typeFilter?: string[];
  /** Emit the metadata card as JSON. Content is opt-in. */
  json?: boolean;
  /** Override default graph (defaults to `framework`, falls back to `project`) */
  graph?: GraphType;
  /** Include full bound rule bodies in addition to summaries and pointers. */
  boundRuleBodies?: boolean;
  body?: boolean;
  sections?: string[];
  rules?: boolean;
  withRuleBodies?: boolean;
  resources?: boolean;
  resource?: string;
  /** When ambiguous, pick the first match instead of erroring */
  first?: boolean;
  /** Query backend. Defaults to Fortemi Core; use local for the legacy path. */
  backend?: 'local' | 'fortemi-core';
  /** Physical source of AIWG-owned resources. Defaults to local. */
  resourceSource?: ResourceSource;
  /** Exact calendar-semver version or signed channel selector for web mode. */
  aiwgVersion?: string;
  /** Prohibit network requests and require verified cached metadata and body bytes. */
  offline?: boolean;
  /** Dependency injection for release-host tests and development. */
  webReleaseOptions?: Omit<WebReleaseOptions, 'selector' | 'offline'>;
}

export interface ShowMetadataParams extends ShowParams {}

function resolveMetadataPath(cwd: string, aiwgRoot: string | null, entry: MetadataEntry): string {
  if (path.isAbsolute(entry.path)) return entry.path;
  const normalizedPath = normalizeIndexedPath(entry.path);
  if (aiwgRoot && normalizedPath.startsWith('agentic/code/')) {
    return path.join(aiwgRoot, normalizedPath);
  }
  if ((entry as ProvenancedEntry).indexScope === 'user' && normalizedPath.startsWith('~/.aiwg/')) {
    return path.join(process.env.HOME ?? '', normalizedPath.slice(2));
  }
  if (normalizedPath.startsWith('.aiwg/')) {
    return projectAiwgPath(cwd, normalizedPath.slice('.aiwg/'.length));
  }
  return path.join(cwd, normalizedPath);
}

async function loadShowEntries(
  cwd: string,
  params: Pick<
    ShowParams,
    'backend' | 'graph' | 'json' | 'name' | 'resourceSource' | 'aiwgVersion' | 'offline' | 'webReleaseOptions' | 'typeFilter'
  >,
  compact = false,
): Promise<{
  entries: MetadataEntry[];
  aiwgRoot: string | null;
  resourceSource: 'local' | 'web';
  webRelease?: VerifiedWebRelease;
  sourcePaths?: import('./fortemi-core-query-adapter.js').FortemiCoreVerifiedSourcePaths;
  relations?: RelationsReader;
}> {
  const aiwgRoot = resolveFrameworkIndexRoot(cwd);
  const backend = params.backend ?? DEFAULT_ARTIFACT_SEARCH_BACKEND;
  let resourceSource: ResourceSource = params.resourceSource ?? 'local';
  let entries: MetadataEntry[] = [];
  let relations: RelationsReader | undefined;

  if (compact && resourceSource !== 'web' && (!params.graph || params.graph === 'framework')) {
    relations = await ensureRelations(cwd) ?? undefined;
    if (relations?.index.artifacts) {
      const reader = relations;
      const matched = findShowMatches(Object.values(reader.index.artifacts!) as MetadataEntry[], params.typeFilter ?? [...OPERATIONAL_SHOW_TYPES], params.name.trim());
      const frameworkEntries = matched.map(entry => {
        const id = discoveryIdForEntry(entry);
        const rule = reader.index.rules[id];
        return withIndexProvenance({ ...entry, phase: '', tags: [], created: '', updated: '', checksum: '', summary: '', dependencies: [], dependents: [],
          ...(rule ? { activation: reader.pinnedRuleIds.has(id) ? 'kernel' : rule.activation ?? undefined,
            ruleSummary: rule.summary, ruleEnforcement: rule.enforcement ?? undefined, bound_to: rule.bound_to } : {}),
        } as MetadataEntry, 'framework');
      });
      const localEntries = params.graph ? [] : defaultCapabilityGraphs(cwd).filter(graph => graph !== 'framework')
        .flatMap(graph => loadLocalCapabilityEntries(cwd, graph));
      const compactEntries = [...localEntries, ...frameworkEntries];
      if ((params.typeFilter?.every(type => ['skill', 'agent', 'flow', 'command', 'rule', 'behavior'].includes(type)))
        || findShowMatches(compactEntries, params.typeFilter ?? [...OPERATIONAL_SHOW_TYPES], params.name.trim()).length) {
        return { entries: compactEntries, aiwgRoot, resourceSource: 'local', relations };
      }
    }
  }

  if (resourceSource !== 'web' && (!params.graph || params.graph === 'framework')) {
    const root = resolveFrameworkCorpusRoot(cwd) ?? aiwgRoot;
    if (root) {
      try {
        await refreshFrameworkCapabilities(root, backend === 'fortemi-core' && params.backend !== undefined);
      } catch (error) {
        console.error(`Warning: capability index refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (resourceSource === 'auto' && backend === 'fortemi-core') {
    const { loadFortemiCoreMetadataEntries } = await import('./fortemi-core-query-adapter.js');
    const localGraphs = params.graph ? [params.graph] : defaultCapabilityGraphs(cwd);
    resourceSource = localGraphs.some(
      (graph) => loadFortemiCoreMetadataEntries(cwd, graph).entries.length > 0,
    ) ? 'local' : 'web';
  } else if (resourceSource === 'auto') {
    resourceSource = 'local';
  }

  if (resourceSource === 'web') {
    if (backend !== 'fortemi-core') {
      console.error('Error: --resource-source web requires the Fortemi Core query backend; --backend local remains available with local resources.');
      process.exit(1);
    }
    if (params.graph && params.graph !== 'framework') {
      console.error("Error: web-backed show currently supports only the 'framework' graph.");
      process.exit(1);
    }
    try {
      const { resolveWebRelease } = await import('../resources/web-release.js');
      const webRelease = await resolveWebRelease({
        ...params.webReleaseOptions,
        selector: params.aiwgVersion ?? 'stable',
        offline: params.offline,
      });
      const sourcePaths = {
        manifestPath: webRelease.fortemiManifestPath,
        exportPath: webRelease.fortemiExportPath,
        manifestSha256: webRelease.fortemiManifestSha256,
        manifestSize: webRelease.fortemiManifestSize,
        exportSha256: webRelease.fortemiExportSha256,
        exportSize: webRelease.fortemiExportSize,
      };
      const { loadFortemiCoreMetadataEntries } = await import('./fortemi-core-query-adapter.js');
      const loaded = loadFortemiCoreMetadataEntries(cwd, 'framework', sourcePaths);
      if (loaded.reason) throw new Error(loaded.reason);
      entries = loaded.entries.map((entry) => withIndexProvenance(entry, 'framework'));
      return { entries, aiwgRoot, resourceSource: 'web', webRelease, sourcePaths };
    } catch (error) {
      console.error(`Error: AIWG web resource resolution failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  // Preserve the direct API's historical local-index behavior when callers
  // omit `backend`. The CLI always passes its explicit Fortemi default, while
  // an explicit `auto` source also opts into Fortemi-backed availability.
  if (params.backend === 'fortemi-core' || params.resourceSource === 'auto') {
    const { loadFortemiCoreMetadataEntries } = await import('./fortemi-core-query-adapter.js');
    const graphs = params.graph ? [params.graph] : defaultCapabilityGraphs(cwd);
    let unavailableReason: string | undefined;
    for (const graph of graphs) {
      const loaded = loadFortemiCoreMetadataEntries(cwd, graph);
      if (loaded.reason && graph === 'project' && !params.graph) {
        const fallback = projectCapabilityFallback(cwd);
        if (fallback) {
          entries.push(...fallback);
          continue;
        }
      }
      if (loaded.reason) {
        unavailableReason ??= loaded.reason;
        if (graph === 'framework' && !params.graph) {
          console.error(`Warning: framework capabilities are unavailable: ${loaded.reason}`);
        }
      }
      entries.push(...loaded.entries.map((entry) => withIndexProvenance(entry, graph)));
    }
    if (entries.length === 0 && unavailableReason) {
      if (params.json) {
        console.log(JSON.stringify({
          backend: 'fortemi-core',
          name: params.name,
          error: unavailableReason,
        }, null, 2));
      } else {
        console.error('Error: ' + unavailableReason);
      }
      process.exit(1);
    }
  } else {
    entries = loadLocalCapabilityEntries(cwd, params.graph);
  }
  return { entries, aiwgRoot, resourceSource: 'local', relations };
}

/** Local index inputs shared by show and exact rule-binding validation (#2938). */
export function loadLocalCapabilityEntries(
  cwd: string, graph?: GraphType, snapshot?: Map<string, MetadataEntry[]>,
): MetadataEntry[] {
  const entries: MetadataEntry[] = [];
  for (const selectedGraph of graph ? [graph] : defaultCapabilityGraphs(cwd)) {
    const key = snapshot && `${selectedGraph}:${getGraphIndexDir(cwd, selectedGraph)}`;
    let selected = key ? snapshot!.get(key) : undefined;
    if (!selected) {
      const index = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', selectedGraph);
      selected = index ? Object.values(index.entries).map(entry => withIndexProvenance(entry, selectedGraph)) : [];
      if (key) snapshot!.set(key, selected);
    }
    entries.push(...selected);
  }
  if (!graph && entries.length === 0) {
    const legacy = loadMetadataIndex(cwd);
    if (legacy) entries.push(...Object.values(legacy.entries));
  }
  return entries;
}

/** Project/user inputs only; package artifacts come from a validated compact table. */
export function loadLocalOverrideCapabilityEntries(cwd: string): MetadataEntry[] {
  const local = defaultCapabilityGraphs(cwd).filter(graph => graph !== 'framework')
    .flatMap(graph => loadLocalCapabilityEntries(cwd, graph));
  if (local.length) return local;
  const canonical = (directory: string): string => {
    try { return fs.realpathSync(directory); } catch { return path.resolve(directory); }
  };
  const packageRoot = canonical(resolveFrameworkIndexRoot(cwd));
  // Retain the legacy PROJECT index, never use the package's full index as a fallback.
  if (canonical(cwd) === packageRoot) return [];
  const legacy = loadMetadataIndex(cwd);
  return Object.values(legacy?.entries ?? {}).filter(entry => {
    const provenance = entry as ProvenancedEntry;
    if (provenance.indexGraph === 'framework' || provenance.indexScope === 'packaged'
      || normalizeIndexedPath(entry.path).startsWith('agentic/code/')) return false;
    const relative = path.relative(packageRoot, path.resolve(cwd, entry.path));
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  }).map(entry => withIndexProvenance(entry, 'project'));
}

function findShowMatches(entries: MetadataEntry[], types: string[], needle: string): MetadataEntry[] {
  const needleLower = needle.toLowerCase();
  const normalizedNeedle = normalizeIndexedPath(needle);
  const candidates = entries.filter(e => types.includes(e.type));

  let matches = needle.startsWith('aiwg:') ? candidates.filter(e => discoveryIdForEntry(e) === needle) : [];
  if (matches.length === 0) {
    matches = candidates.filter(e => e.path === needle || normalizeIndexedPath(e.path) === normalizedNeedle);
  }
  if (matches.length === 0) {
    matches = candidates.filter(e => {
      const normalizedPath = normalizeIndexedPath(e.path);
      const dirStem = path.basename(path.dirname(normalizedPath));
      const basename = path.basename(normalizedPath);
      const fileStem = basename.replace(/\.[^.]+$/, '');
      const slugLayoutMatch =
        ((basename === 'SKILL.md' && e.type === 'skill') ||
          (basename === 'BEHAVIOR.md' && e.type === 'behavior')) &&
        dirStem === needle;
      if (slugLayoutMatch || fileStem === needle || e.name === needle) return true;
      if (e.type === 'gate-pack' && typeof e.name === 'string') {
        const gateStem = fileStem.replace(/\.gatepack$/i, '');
        const rest = e.name.includes(':') ? e.name.slice(e.name.indexOf(':') + 1) : e.name;
        const short = rest.includes('/') ? rest.slice(rest.indexOf('/') + 1) : rest;
        return gateStem === needle || rest === needle || short === needle;
      }
      return false;
    });
  }
  if (matches.length === 0) {
    matches = candidates.filter(e =>
      typeof e.title === 'string' && e.title.toLowerCase() === needleLower,
    );
  }

  matches = uniqueEntriesByPath(matches);
  matches = matches.sort((a, b) => scopeRank(a) - scopeRank(b) || a.path.localeCompare(b.path));

  if (matches.length > 1) {
    const sameIdentity = matches.every((entry) =>
      entry.type === matches[0].type &&
      (entry.name ?? '').toLowerCase() === (matches[0].name ?? '').toLowerCase(),
    );
    if (sameIdentity && scopeRank(matches[0]) < scopeRank(matches[1])) {
      matches = [matches[0]];
    }
  }
  if (matches.length > 1 && types.includes('skill')) {
    const frameworkSkillMatches = matches.filter(e => isFrameworkSourceSkillPath(e.path));
    if (frameworkSkillMatches.length === 1) matches = frameworkSkillMatches;
  }
  if (matches.length > 1 && types.includes('skill')) {
    const sourceSkillMatches = matches.filter(e => isCanonicalSourceSkillPath(e.path));
    if (sourceSkillMatches.length === 1) matches = sourceSkillMatches;
  }
  if (matches.length > 1 && types.includes('agent')) {
    const canonicalSourceMatches = matches.filter(e => isCanonicalSourceAgentPath(e.path));
    if (canonicalSourceMatches.length === 1) matches = canonicalSourceMatches;
  }
  if (matches.length > 1 && types.includes('agent')) {
    const canonicalBundleMatches = matches.filter(e => isCanonicalBundleAgentPath(e.path));
    const canonicalBundlePaths = uniqueEntriesByPath(canonicalBundleMatches);
    if (canonicalBundlePaths.length === 1) matches = canonicalBundlePaths;
  }
  if (matches.length > 1 && types.includes('agent')) {
    const nonPersonaMatches = matches.filter(e => !isTopLevelPersonaAgentPath(e.path));
    if (nonPersonaMatches.length === 1) matches = nonPersonaMatches;
  }
  return matches;
}

/** Preselect exact candidates once; the canonical resolver still owns precedence and ambiguity. */
export function createRuleBindingTargetResolver(entries: MetadataEntry[]): (
  type: 'skill' | 'agent' | 'flow', id: string,
) => MetadataEntry {
  const candidates = new Map<string, MetadataEntry[]>();
  for (const entry of entries) {
    if (!['skill', 'agent', 'flow'].includes(entry.type)) continue;
    const normalized = normalizeIndexedPath(entry.path);
    const basename = path.posix.basename(normalized);
    const slug = /^(?:SKILL|AGENT|FLOW)\.md$/i.test(basename)
      ? path.posix.basename(path.posix.dirname(normalized))
      : basename.replace(/\.[^.]+$/, '');
    for (const id of new Set([entry.name, discoveryIdForEntry(entry), slug])) {
      if (typeof id !== 'string') continue;
      const key = `${entry.type}\0${id}`;
      const selected = candidates.get(key) ?? [];
      selected.push(entry);
      candidates.set(key, selected);
    }
  }
  return (type, id) => resolveRuleBindingTarget(candidates.get(`${type}\0${id}`) ?? [], type, id);
}

/** Resolve exact rule binding IDs using the same precedence and ambiguity as show.
 * Canonical layout slugs remain valid when frontmatter names are display names.
 * Titles and filesystem paths are deliberately excluded (#2938).
 */
export function resolveRuleBindingTarget(
  entries: MetadataEntry[], type: 'skill' | 'agent' | 'flow', id: string,
): MetadataEntry {
  const exact = entries.filter(entry => {
    if (entry.type !== type) return false;
    const normalized = normalizeIndexedPath(entry.path);
    const basename = path.posix.basename(normalized);
    const slug = /^(?:SKILL|AGENT|FLOW)\.md$/i.test(basename)
      ? path.posix.basename(path.posix.dirname(normalized))
      : basename.replace(/\.[^.]+$/, '');
    return entry.name === id || discoveryIdForEntry(entry) === id || slug === id;
  });
  let matches = findShowMatches(exact, [type], id);
  // Generated plugin copies (agentic/code/plugins/*) mirror canonical framework
  // and addon artifacts. Prefer the canonical source when it is unambiguous.
  if (matches.length > 1) {
    const canonical = matches.filter(entry => !/(^|\/)agentic\/code\/plugins\//.test(normalizeIndexedPath(entry.path)));
    if (canonical.length === 1) matches = canonical;
  }
  if (matches.length === 0) throw new Error(`Missing ${type} binding target: ${id}`);
  if (matches.length > 1) throw new Error(`Ambiguous ${type} binding target: ${id}: ${matches.map(entry => entry.path).join(', ')}`);
  return matches[0];
}

async function fortemiRecordForEntry(
  cwd: string,
  entry: MetadataEntry,
  sourcePaths?: import('./fortemi-core-query-adapter.js').FortemiCoreVerifiedSourcePaths,
): Promise<AiwgFortemiRecord | null> {
  const graph = ((entry as ProvenancedEntry).indexGraph ?? 'project') as GraphType;
  const { loadFortemiCoreExport } = await import('./fortemi-core-query-adapter.js');
  const loaded = loadFortemiCoreExport(cwd, graph, sourcePaths);
  if (!loaded.exported) return null;
  const id = discoveryIdForEntry(entry);
  return loaded.exported.items.find((record) => record.id === id || record.source.path === entry.path) ?? null;
}

/**
 * Scan bundle `gate-packs/` directories for a pack matching `needle` (#2830).
 *
 * Accepts the full namespaced id, the rest-path or the short pack name and
 * probes `<bundle>/gate-packs/<pack>.gatepack.{yaml,yml,json}`. Never looks
 * under `gates/`, which agent-persistence HITL owns.
 */
async function findGatePackInCorpus(
  groups: Array<{ kind: 'framework' | 'addon' | 'extension' | 'plugin'; dir: string }>,
  needle: string,
): Promise<{ path: string; bundleKind: 'framework' | 'addon' | 'extension' | 'plugin' | null; bundleId: string | null } | null> {
  const path = await import('node:path');
  const fsp = (await import('node:fs')).promises;
  const trimmed = needle.trim();
  const rest = trimmed.includes(':') ? trimmed.slice(trimmed.indexOf(':') + 1) : trimmed;
  const slash = rest.indexOf('/');
  const wantedBundle = slash >= 0 ? rest.slice(0, slash) : null;
  const wantedPack = slash >= 0 ? rest.slice(slash + 1) : rest;
  if (!wantedPack || /\s/.test(wantedPack) || wantedPack.includes(':') || wantedPack.includes('/')) return null;
  const extensions = ['.gatepack.yaml', '.gatepack.yml', '.gatepack.json'];
  const ordered = wantedBundle
    ? groups.flatMap(group => [{ group, bundle: wantedBundle }])
    : null;
  const probe = async (
    group: { kind: 'framework' | 'addon' | 'extension' | 'plugin'; dir: string },
    bundle: string,
  ): Promise<{ path: string; bundleKind: 'framework' | 'addon' | 'extension' | 'plugin' | null; bundleId: string | null } | null> => {
    for (const extension of extensions) {
      const candidate = path.join(group.dir, bundle, 'gate-packs', `${wantedPack}${extension}`);
      try {
        const stat = await fsp.stat(candidate);
        if (stat.isFile()) return { path: candidate, bundleKind: group.kind, bundleId: bundle };
      } catch {
        // not present — continue
      }
    }
    return null;
  };
  if (ordered) {
    for (const { group, bundle } of ordered) {
      const found = await probe(group, bundle);
      if (found) return found;
    }
    return null;
  }
  for (const group of groups) {
    let bundles: string[];
    try {
      bundles = (await fsp.readdir(group.dir, { withFileTypes: true }))
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();
    } catch {
      continue;
    }
    for (const bundle of bundles) {
      const found = await probe(group, bundle);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Scan the AIWG_ROOT corpus for an artifact matching `name` (#1221).
 *
 * Walks the well-known artifact layouts under
 * `agentic/code/{frameworks,addons,extensions,plugins}/<bundle>/{skills,agents,commands,rules,templates,behaviors,flows}/`
 * and returns the first match. Used as a fallback in `aiwg show` when an
 * artifact isn't in any built index — either because the workspace hasn't
 * been deployed to yet, or because the bundle hasn't been installed.
 *
 * Returns the resolved absolute path plus enough metadata for the caller
 * to surface a useful install hint. Returns null if nothing matches.
 */
async function findCorpusArtifact(
  aiwgRoot: string,
  name: string,
  typeFilter: string[],
): Promise<{
  path: string;
  type: string;
  bundleKind: 'framework' | 'addon' | 'extension' | 'plugin' | null;
  bundleId: string | null;
} | null> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const fsp = fs.promises;

  const groups: Array<{ kind: 'framework' | 'addon' | 'extension' | 'plugin'; dir: string }> = [
    { kind: 'framework', dir: path.join(aiwgRoot, 'agentic/code/frameworks') },
    { kind: 'addon', dir: path.join(aiwgRoot, 'agentic/code/addons') },
    { kind: 'extension', dir: path.join(aiwgRoot, 'agentic/code/extensions') },
    { kind: 'plugin', dir: path.join(aiwgRoot, 'agentic/code/plugins') },
  ];

  // (subdir, type, layout) — 'flat' = `<name>.md`, 'slug' = `<name>/SKILL.md`
  const tries: Array<{ sub: string; type: string; layout: 'flat' | 'slug'; extension?: '.md' | '.json' | '.yaml' }> = [
    { sub: 'skills', type: 'skill', layout: 'slug' },
    { sub: 'skills', type: 'skill', layout: 'flat' },
    { sub: 'agents', type: 'agent', layout: 'flat' },
    { sub: 'commands', type: 'command', layout: 'flat' },
    { sub: 'rules', type: 'rule', layout: 'flat' },
    { sub: 'templates', type: 'template', layout: 'flat' },
    { sub: 'behaviors', type: 'behavior', layout: 'flat' },
    { sub: 'flows', type: 'flow', layout: 'flat' },
    { sub: 'runbooks', type: 'runbook', layout: 'flat' },
    { sub: 'decisions', type: 'decision-definition', layout: 'flat', extension: '.json' },
    { sub: 'rulesets', type: 'decision-ruleset', layout: 'flat', extension: '.json' },
    { sub: 'bindings', type: 'decision-binding', layout: 'flat', extension: '.json' },
  ];

  for (const group of groups) {
    let bundles: string[];
    try {
      bundles = (await fsp.readdir(group.dir, { withFileTypes: true }))
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      continue;
    }
    for (const bundle of bundles) {
      for (const t of tries) {
        if (typeFilter.length > 0 && !typeFilter.includes(t.type)) continue;
        const candidate = t.layout === 'slug'
          ? path.join(group.dir, bundle, t.sub, name, 'SKILL.md')
          : path.join(group.dir, bundle, t.sub, `${name}${t.extension ?? '.md'}`);
        try {
          const stat = await fsp.stat(candidate);
          if (stat.isFile()) {
            return { path: candidate, type: t.type, bundleKind: group.kind, bundleId: bundle };
          }
        } catch {
          // not present — continue
        }
      }
    }
  }

  // Gate packs live in `<bundle>/gate-packs/*.gatepack.yaml|json` (never
  // `gates/`, which agent-persistence HITL uses). The needle may be the full
  // namespaced id (`aiwg:decision-engine/integrity-ceiling`), the rest-path
  // (`decision-engine/integrity-ceiling`) or the short pack name
  // (`integrity-ceiling`). (#2830)
  if (typeFilter.length === 0 || typeFilter.includes('gate-pack')) {
    const gateMatch = await findGatePackInCorpus(groups, name);
    if (gateMatch) return { ...gateMatch, type: 'gate-pack' };
  }

  // Top-level agents live at `agentic/code/agents/<category>/<name>.md`
  // (e.g. `personas/aiwg-writer.md`) — a flat-under-category layout the
  // bundle groups above do not cover. Scan it directly so persona/agent
  // `show` survives un-indexed (or stale-framework-index) workspaces, where
  // the corpus fallback is the only resolution path. (#1623 U5)
  if (typeFilter.length === 0 || typeFilter.includes('agent')) {
    const agentMatch = await findAgentInCorpus(
      path.join(aiwgRoot, 'agentic/code/agents'),
      name,
    );
    if (agentMatch) {
      return { path: agentMatch, type: 'agent', bundleKind: null, bundleId: null };
    }
  }

  // Behaviors commonly use a slug layout: `behaviors/<name>/BEHAVIOR.md`.
  if (typeFilter.length === 0 || typeFilter.includes('behavior')) {
    for (const group of groups) {
      let bundles: string[];
      try {
        bundles = (await fsp.readdir(group.dir, { withFileTypes: true }))
          .filter(d => d.isDirectory())
          .map(d => d.name);
      } catch {
        continue;
      }
      for (const bundle of bundles) {
        const candidate = path.join(group.dir, bundle, 'behaviors', name, 'BEHAVIOR.md');
        try {
          const stat = await fsp.stat(candidate);
          if (stat.isFile()) {
            return { path: candidate, type: 'behavior', bundleKind: group.kind, bundleId: bundle };
          }
        } catch {
          // not present — continue
        }
      }
    }
  }

  return null;
}

/**
 * Recursively scan `agentic/code/agents` for a flat `<name>.md` agent file.
 *
 * Agents use an `agents/<category>/<name>.md` layout (e.g. `personas/`) that
 * differs from the bundle `<dir>/<bundle>/<sub>/<name>.md` layout the generic
 * corpus scan walks, so persona agents are otherwise missed. Bounded depth —
 * the agents tree is shallow. Returns the first matching absolute path, or
 * null. Direct files at each level take priority over subdirectories. (#1623)
 */
async function findAgentInCorpus(
  agentsRoot: string,
  name: string,
  depth = 0,
): Promise<string | null> {
  if (depth > 3) return null;
  const fs = await import('node:fs');
  const path = await import('node:path');
  const fsp = fs.promises;

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(agentsRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  // Prefer a direct `<name>.md` at this level before descending.
  for (const entry of entries) {
    if (entry.isFile() && entry.name === `${name}.md`) {
      return path.join(agentsRoot, entry.name);
    }
  }
  // Descend into category subdirectories (e.g. personas/).
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await findAgentInCorpus(path.join(agentsRoot, entry.name), name, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Build an ephemeral reverse lookup from the already-loaded rule metadata. */
export function rulesBoundTo(entries: MetadataEntry[], target: MetadataEntry): MetadataEntry[] {
  const key = ({ skill: 'skills', agent: 'agents', flow: 'flows' } as const)[target.type as 'skill' | 'agent' | 'flow'];
  if (!key) return [];
  const file = path.basename(normalizeIndexedPath(target.path));
  const aliases = [target.name, target.title, target.path, discoveryIdForEntry(target),
    file === 'SKILL.md' ? path.basename(path.dirname(normalizeIndexedPath(target.path))) : file.replace(/\.[^.]+$/, '')]
    .filter((alias): alias is string => !!alias);
  const seen = new Set<string>();
  return entries.filter(rule => {
    if (rule.type !== 'rule' && rule.type !== 'behavior') return false;
    const patterns = rule.bound_to?.[key];
    if (!Array.isArray(patterns) || !patterns.some(pattern => typeof pattern === 'string'
      && aliases.some(alias => alias === pattern || minimatch(alias, pattern, { nonegate: true, nocomment: true })))) return false;
    const identity = `${rule.type}:${rule.path}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).sort((a, b) => (a.name ?? a.path).localeCompare(b.name ?? b.path) || a.path.localeCompare(b.path));
}

/** Relationship metadata for shipped targets, merged with project/user contracts. */
export function relationshipRules(entries: MetadataEntry[], target: MetadataEntry, relations?: RelationsReader): MetadataEntry[] {
  const local = rulesBoundTo(relations ? entries.filter(entry => !normalizeIndexedPath(entry.path).startsWith('agentic/code/')) : entries, target);
  if (!relations || !['skill', 'agent', 'flow', 'command'].includes(target.type)) return local;
  const asMetadata = (id: string): MetadataEntry => {
    const rule = relations.index.rules[id];
    return { path: rule.path, type: rule.type, name: rule.name, activation: rule.activation ?? undefined,
      bound_to: rule.bound_to, ruleSummary: rule.summary, ruleEnforcement: rule.enforcement ?? undefined, rulePaths: rule.paths, triggers: rule.triggers } as MetadataEntry;
  };
  const key = `${target.type}:${discoveryIdForEntry(target)}`;
  const shipped = Object.hasOwn(relations.index.targets, key)
    ? relations.rulesForTarget(target.type as RelationTargetType, discoveryIdForEntry(target)).map(asMetadata)
    // Project/user overrides keep the old alias/glob behavior using only small records.
    : rulesBoundTo(Object.keys(relations.index.rules).map(asMetadata), target);
  const merged = new Map([...local, ...shipped].map(rule => [`${rule.type}:${rule.path}`, rule]));
  return [...merged.values()].sort((a, b) => (a.name ?? a.path).localeCompare(b.name ?? b.path) || a.path.localeCompare(b.path));
}

export interface GoverningRule { rule: MetadataEntry; applicability: string[] }
export const RULE_CHECK_OBLIGATION = 'Before governed work, fetch and follow every required rule below; a discovery summary is not the full rule.';
function relationMetadata(relations: RelationsReader): MetadataEntry[] {
  return Object.values(relations.index.rules).map(rule => ({ path: rule.path, type: rule.type, name: rule.name,
    activation: rule.activation ?? undefined, ruleSummary: rule.summary, ruleEnforcement: rule.enforcement ?? undefined,
    bound_to: rule.bound_to, rulePaths: rule.paths, triggers: rule.triggers } as MetadataEntry));
}
/** Post-ranking enrichment: relationship lookup never loads the full metadata index. */
export function compoundGoverningRules(entries: MetadataEntry[], target: MetadataEntry, relations?: RelationsReader,
  phrase = '', includeMatches = true, excludeKernel = true): GoverningRule[] {
  if (!['skill', 'agent', 'flow', 'command'].includes(target.type)) return [];
  const found = new Map<string, GoverningRule>();
  const add = (rule: MetadataEntry, why: string) => {
    const activation = rule.activation ?? (rule.type === 'behavior' ? 'kernel' : inferRuleActivation(rule.ruleEnforcement));
    if (excludeKernel && (activation === 'kernel' || rule.kernel || relations?.pinnedRuleIds.has(discoveryIdForEntry(rule)))) return;
    const key = `${rule.type}:${rule.path}`, item = found.get(key) ?? { rule, applicability: [] };
    if (!item.applicability.includes(why)) item.applicability.push(why);
    found.set(key, item);
  };
  for (const rule of relationshipRules(entries, target, relations)) add(rule, `bound:${target.type}:${discoveryIdForEntry(target)}`);
  if (relations && target.type === 'skill' && target.name?.startsWith('projected:')) {
    for (const id of relations.rulesForTarget('skill', target.name)) {
      const rule = relationMetadata(relations).find(rule => discoveryIdForEntry(rule) === id);
      if (rule) add(rule, `projected-flow:${target.name.slice('projected:'.length)}`);
    }
  }
  if (includeMatches) {
    const query = phrase.toLowerCase();
    const queryPaths = (phrase.replace(/\\/g, '/').match(/[\w@./*?-]+/g) ?? []).map(value => value.replace(/[.,;:!?]+$/, ''));
    const corpus = relations ? relationMetadata(relations) : [];
    const rules = new Map([...corpus, ...entries.filter(entry => ['rule', 'behavior'].includes(entry.type))]
      .map(rule => [`${rule.type}:${rule.path}`, rule]));
    for (const rule of rules.values()) {
      for (const glob of rule.rulePaths ?? []) for (const candidate of [...queryPaths.filter(value => /[./*?]/.test(value) || value === glob), ...(target.governedPaths ?? [])]) {
        if (minimatch(candidate, glob, { dot: true, nonegate: true, nocomment: true })
          || ((target.governedPaths ?? []).includes(candidate) && minimatch(glob, candidate, { dot: true, nonegate: true, nocomment: true }))) add(rule, `path:${candidate}`);
      }
      for (const trigger of rule.triggers ?? []) {
        const normalized = trigger.trim().toLowerCase();
        let offset = normalized ? query.indexOf(normalized) : -1;
        while (offset >= 0) {
          if ((offset === 0 || !/\w/.test(query[offset - 1]))
            && (offset + normalized.length === query.length || !/\w/.test(query[offset + normalized.length]))) {
            add(rule, `trigger:${trigger}`); break;
          }
          offset = query.indexOf(normalized, offset + 1);
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => (a.rule.name ?? a.rule.path).localeCompare(b.rule.name ?? b.rule.path) || a.rule.path.localeCompare(b.rule.path));
}
function boundRuleDescriptor(rule: MetadataEntry) {
  return { name: rule.name ?? path.basename(rule.path, '.md'), activation: rule.activation ?? null, enforcement: rule.ruleEnforcement ?? null,
    summary: (rule.ruleSummary ?? '').replace(/\s+/g, ' ').trim(), show_command: `aiwg show ${rule.type} ${rule.name ?? path.basename(rule.path, '.md')} --body` };
}
/** Counts unique attached contracts; every emitted check is required irrespective of severity. */
export function governingRuleStats(governing: GoverningRule[]): RuleStats {
  const stats = emptyRuleStats();
  for (const { rule } of new Map(governing.map(item => [`${item.rule.type}:${item.rule.path}`, item])).values()) {
    const enforcement = rule.ruleEnforcement?.toLowerCase() ?? 'unknown', activation = rule.activation ?? 'unknown';
    stats.by_enforcement[enforcement] = (stats.by_enforcement[enforcement] ?? 0) + 1;
    stats.by_activation[activation] = (stats.by_activation[activation] ?? 0) + 1;
    stats.required_checks++;
  }
  return stats;
}
export function governingRuleFields(governing: GoverningRule[]) {
  if (!governing.length) return {};
  return { bound_rules: governing.map(({ rule }) => boundRuleDescriptor(rule)), rule_stats: governingRuleStats(governing),
    required_rule_checks: governing.map(({ rule, applicability }) => ({ rule_id: discoveryIdForEntry(rule),
      applicability, fetch_command: `aiwg show ${rule.type} ${discoveryIdForEntry(rule)} --body` })), rule_check_obligation: RULE_CHECK_OBLIGATION };
}
function statsText(stats: RuleStats): string {
  return `rules: ${Object.entries(stats.by_enforcement).map(([level, count]) => `${count} ${level}`).join(', ') || '0'} · activation: ${Object.entries(stats.by_activation).map(([mode, count]) => `${count} ${mode}`).join(', ') || 'none'} · ${stats.required_checks} required checks`;
}

export function relationshipRuleStats(entries: MetadataEntry[], target: MetadataEntry, relations: RelationsReader): RuleStats {
  const shipped = Object.hasOwn(relations.index.targets, `${target.type}:${discoveryIdForEntry(target)}`);
  const stats = shipped ? relations.ruleStats(target.type as RelationTargetType, discoveryIdForEntry(target)) : emptyRuleStats();
  // Shipped counts are precomputed; project/user contracts and overrides are overlays.
  const overlay = shipped ? rulesBoundTo(entries.filter(entry => !normalizeIndexedPath(entry.path).startsWith('agentic/code/')), target)
    : relationshipRules(entries, target, relations);
  for (const rule of overlay) {
    const enforcement = rule.ruleEnforcement ?? 'unknown';
    const activation = rule.activation ?? 'unknown';
    stats.by_enforcement[enforcement] = (stats.by_enforcement[enforcement] ?? 0) + 1;
    stats.by_activation[activation] = (stats.by_activation[activation] ?? 0) + 1;
    if (enforcement === 'critical' || enforcement === 'high') stats.required_checks++;
  }
  return stats;
}

async function showBindings(
  entries: MetadataEntry[], target: MetadataEntry, content: string, params: ShowParams,
  read: (entry: MetadataEntry) => Promise<string>,
  relations?: RelationsReader,
): Promise<{ fields: Record<string, unknown>; text: string }> {
  const governing = compoundGoverningRules(entries, target, relations, '', false, false);
  for (const { rule } of governing) if (relations?.pinnedRuleIds.has(discoveryIdForEntry(rule))) rule.activation = 'kernel';
  const rules = governing.map(item => item.rule);
  const boundRules = await Promise.all(rules.map(async rule => ({
    ...boundRuleDescriptor(rule),
    ...((params.boundRuleBodies || params.withRuleBodies) ? { content: await read(rule) } : {}),
  })));
  // Parse the selected rule for reverse lookup, including corpus-only rules.
  const targets = target.type === 'rule' || target.type === 'behavior'
    ? parseFrontmatter(content).data.bound_to : undefined;
  const boundTo = targets && typeof targets === 'object' && !Array.isArray(targets)
    ? Object.fromEntries(['skills', 'agents', 'flows'].flatMap(key => {
        const values = (targets as Record<string, unknown>)[key];
        const names = Array.isArray(values) ? [...new Set(values.filter((value): value is string => typeof value === 'string' && !!value.trim()))] : [];
        return names.length ? [[key, names]] : [];
      })) : {};
  const boundTargets = new Map<string, { type: string; id: string; name?: string }>();
  if (target.type === 'rule' || target.type === 'behavior') {
    for (const edge of relations?.targetsForRule(discoveryIdForEntry(target)) ?? []) {
      boundTargets.set(`${edge.type}:${edge.id}`, { ...edge, name: relations?.index.artifacts?.[edge.id]?.name
        ?? relations?.index.targets[`${edge.type}:${edge.id}`]?.name });
    }
    const selectedRule = { ...target, bound_to: boundTo } as MetadataEntry;
    for (const candidate of entries) if (rulesBoundTo([selectedRule], candidate).length) {
      const id = discoveryIdForEntry(candidate);
      boundTargets.set(`${candidate.type}:${id}`, { type: candidate.type, id, name: candidate.name });
    }
  }
  let text = '';
  if (boundRules.length) {
    // Cards already print these stats in the header; body/section output has no header.
    const stats = params.body || params.sections?.length ? `${statsText(governingRuleStats(governing))}\n\n` : '';
    text += `\n## Bound rules\n\n${RULE_CHECK_OBLIGATION}\n\n${stats}` + boundRules.map(rule =>
      `- **${rule.name}** [${rule.activation ?? 'unknown'} / ${rule.enforcement ?? 'unknown'}]: ${rule.summary} (\`${rule.show_command}\`)`
      + ('content' in rule ? `\n\n${rule.content}` : '')).join('\n') + '\n';
  }
  if (Object.keys(boundTo).length) {
    text += '\n## Bound targets\n\n' + Object.entries(boundTo)
      .map(([key, names]) => `- ${key}: ${(names as string[]).map(name => `\`${name}\``).join(', ')}`).join('\n') + '\n';
  }
  if (boundTargets.size) text += '\nResolved targets: ' + [...boundTargets.values()].map(target => `${target.type} ${target.name ?? target.id}`).join(', ') + '\n';
  return { fields: {
    ...governingRuleFields(governing),
    ...(['rule', 'behavior'].includes(target.type) ? { bound_to: boundTo, bound_targets: [...boundTargets.values()] } : {}),
    ...(boundRules.length ? { bound_rules: boundRules } : {}),
    ...(Object.keys(boundTo).length ? { bound_to: boundTo } : {}),
  }, text };
}

/** Sections include their nested headings, stopping at the next peer/ancestor. */
function showSections(content: string) {
  const body = parseFrontmatter(content).body;
  const headings: Array<{ heading: string; level: number; start: number }> = [];
  let offset = 0;
  let fence = '';
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
    } else if (!fence) {
      const atx = line.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
      const setext = i + 1 < lines.length && lines[i + 1].match(/^ {0,3}(=+|-+)\s*$/);
      if (atx) headings.push({ heading: atx[2], level: atx[1].length, start: offset });
      else if (line.trim() && setext) headings.push({ heading: line.trim(), level: setext[1][0] === '=' ? 1 : 2, start: offset });
    }
    offset += line.length;
  }
  return headings.map((heading, i) => {
    const end = headings.slice(i + 1).find(next => next.level <= heading.level)?.start ?? body.length;
    const text = body.slice(heading.start, end);
    return { heading: heading.heading, level: heading.level, bytes: Buffer.byteLength(text),
      lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0), text };
  });
}

/** List companion directories and explicitly linked resources within the owning bundle.
 * Resolve paths against that boundary and exclude symlink components. */
function showResources(filePath: string, source: string, release?: VerifiedWebRelease): Array<{ path: string; bytes: number }> {
  if (release) {
    const base = path.posix.dirname(filePath);
    const linked = new Set(extractMarkdownLinks(source).map(link => path.posix.normalize(path.posix.join(base, link))));
    const boundary = filePath.match(/^(raw\/agentic\/code\/(?:frameworks|addons|extensions)\/[^/]+)\//)?.[1];
    return [...release.descriptors.values()].filter(descriptor => {
      const relative = path.posix.relative(base, descriptor.path);
      const category = /(?:^|\/)(?:templates|scripts|references|resources|assets)\//.test(relative);
      const inside = relative !== '..' && !relative.startsWith('../');
      return (inside && category || linked.has(descriptor.path) && (inside || category))
        && (!boundary || descriptor.path.startsWith(`${boundary}/`));
    }).map(descriptor => ({ path: path.posix.relative(base, descriptor.path), bytes: descriptor.size }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  const base = path.dirname(filePath);
  const normalizedBase = normalizeIndexedPath(base);
  const boundary = normalizedBase.match(/^(.*\/(?:frameworks|addons|extensions)\/[^/]+)(?:\/|$)/)?.[1]
    ?? normalizedBase.match(/^(.*\/\.aiwg)(?:\/|$)/)?.[1] ?? base;
  const resources = new Map<string, { path: string; bytes: number }>();
  const walk = (relative: string) => {
    const absolute = path.resolve(base, relative);
    const contained = path.relative(boundary, absolute);
    if (contained === '..' || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) return;
    let cursor = boundary;
    let stat: fs.Stats | undefined;
    try {
      for (const component of contained.split(path.sep)) {
        cursor = path.join(cursor, component);
        stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink()) return;
      }
    } catch { return; }
    if (stat?.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) walk(path.join(relative, name));
    } else if (stat?.isFile() && absolute !== filePath) {
      const key = normalizeIndexedPath(path.relative(base, absolute));
      resources.set(key, { path: key, bytes: stat.size });
    }
  };
  for (const directory of ['templates', 'scripts', 'references', 'resources', 'assets']) walk(directory);
  const { data } = parseFrontmatter(source);
  const declared = Array.isArray(data.resources) ? data.resources.filter((value): value is string => typeof value === 'string') : [];
  for (const link of [...extractMarkdownLinks(source), ...declared]) {
    if (path.isAbsolute(link) || /^[a-z]+:/i.test(link)) continue;
    const relative = path.relative(base, path.resolve(base, link));
    // Outside the artifact directory, only declared companion categories qualify.
    if ((relative === '..' || relative.startsWith(`..${path.sep}`)) && !/(?:^|\/)(?:templates|scripts|references|resources|assets)\//.test(normalizeIndexedPath(relative))) continue;
    walk(relative);
  }
  return [...resources.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function emitShowCard(
  cwd: string, aiwgRoot: string | null, entry: MetadataEntry, filePath: string, source: string,
  params: ShowParams, bindings: { fields: Record<string, unknown>; text: string },
  extra: Record<string, unknown>, local: boolean, release?: VerifiedWebRelease,
): Promise<void> {
  const { data } = parseFrontmatter(source);
  const flow = entry.type === 'flow' || entry.type === 'runbook' ? parseFlowDoc(source, entry.path) : null;
  const sections = showSections(source);
  const selected = (params.sections ?? []).map(heading => {
    const exact = sections.filter(section => section.heading === heading);
    const matches = exact.length ? exact : sections.filter(section => section.heading.toLowerCase() === heading.toLowerCase());
    if (matches.length !== 1) throw new Error(`${matches.length ? 'Ambiguous' : 'Unknown'} heading "${heading}". Headings: ${sections.map(section => section.heading).join(', ') || '(none)'}`);
    return matches[0].text;
  });
  const owner = normalizeIndexedPath(entry.path).match(/(?:^|\/)(?:agentic\/code|\.aiwg)\/(frameworks|addons|extensions)\/([^/]+)\//);
  const kind = owner ? ({ frameworks: 'framework', addons: 'addon', extensions: 'extension' } as const)[owner[1] as 'frameworks' | 'addons' | 'extensions'] : null;
  const installed = local && (owner && aiwgRoot
    ? await isCorpusBundleInstalled(cwd, aiwgRoot, kind!, owner[2]) : true);
  const resources = local || release ? showResources(filePath, source, release) : [];
  const resource = params.resource ? resources.find(resource => resource.path === params.resource) : undefined;
  if (params.resource && !resource) throw new Error(`Unknown resource "${params.resource}". Resources: ${resources.map(resource => resource.path).join(', ') || '(none)'}`);
  const quote = (value: string) => '"' + value.replace(/["\\$`]/g, '\\$&') + '"';
  const command = `aiwg show ${entry.type} ${extra.hint ? params.name : discoveryIdForEntry(entry)}`
    + (params.graph ? ` --graph ${quote(params.graph)}` : '')
    + (params.backend ? ` --backend ${params.backend}` : '')
    + (params.resourceSource ? ` --resource-source ${params.resourceSource}` : '')
    + (params.aiwgVersion ? ` --aiwg-version ${quote(params.aiwgVersion)}` : '')
    + (params.offline ? ' --offline' : '');
  let resourceBody: string | undefined;
  if (resource) {
    if (local) resourceBody = fs.readFileSync(path.join(path.dirname(filePath), resource.path), 'utf8');
    else if (release) {
      const { fetchVerifiedRawResource } = await import('../resources/web-release.js');
      resourceBody = (await fetchVerifiedRawResource(release,
        path.posix.normalize(path.posix.join(path.posix.dirname(filePath), resource.path)),
        { ...params.webReleaseOptions, offline: params.offline })).toString('utf8');
    }
  }
  const localPin = extra.local_pin as { canonical_activation: string; matches: Array<{ source: string }> } | undefined;
  const pinNote = localPin ? `Pinned locally: kernel (canonical ${localPin.canonical_activation}; ${localPin.matches.map(match => match.source).join(', ')}).` : '';
  const contentNotice = 'This is a metadata card. The component body has not been fetched. Before deciding or applying its workflow, read the needed sections or --body using the drill-in commands below. Read full governing rules before governed work; --rules alone lists checks.';
  const card = {
    id: discoveryIdForEntry(entry), type: entry.type, name: entry.name ?? String(data.name ?? entry.title),
    title: entry.title, path: filePath, description: String(data.description ?? data.summary ?? flow?.description ?? entry.capability ?? entry.ruleSummary ?? entry.summary ?? ''),
    capability: owner ? { kind, name: owner[2] } : null, installed, kernel: entry.kernel ?? false,
    ...(['rule', 'behavior'].includes(entry.type) ? {
      activation: localPin ? 'kernel' : entry.activation ?? data.activation ?? null, enforcement: data.enforcement ?? entry.ruleEnforcement ?? null,
      bound_to: data.bound_to ?? entry.bound_to ?? {},
    } : {}),
    bound_rules: [], rule_stats: emptyRuleStats(), required_rule_checks: [], rule_check_obligation: RULE_CHECK_OBLIGATION,
    ...bindings.fields,
    outline: sections.map(({ text: _text, ...metadata }) => metadata), resources,
    ...(!params.body && !selected.length ? { content_notice: contentNotice } : {}),
    drill_in: {
      sections: sections.map(section => `${command} --section ${quote(section.heading)}`),
      rules: `${command} --rules`, rule_bodies: `${command} --rules --with-rule-bodies`,
      resources: `${command} --resources`, resource: resources.map(resource => `${command} --resource ${quote(resource.path)}`),
      body: `${command} --body`,
    },
    ...extra,
    ...(params.body || selected.length ? { content: params.body ? source : selected.join('\n') } : {}),
    ...(resource ? { resource: { ...resource, body: resourceBody! } } : {}),
  };
  if (params.json) { console.log(JSON.stringify(card, null, 2)); return; }
  if ('content' in card) {
    if (extra.hint) process.stdout.write(`<!-- AIWG: ${card.installed ? 'installed bundle artifact — not in the selected index.' : 'corpus-only artifact — not in the indexed workspace.'}\n     ${extra.hint}\n     Origin: ${filePath}\n-->\n\n`);
    if (entry.script) process.stdout.write(`<!-- AIWG: executable skill — run via: ${buildRunHint(entry)} -->\n`);
    if (pinNote) process.stdout.write(`${pinNote}\n`);
    process.stdout.write(card.content!);
    if (!card.content!.endsWith('\n')) process.stdout.write('\n');
    if (bindings.text) process.stdout.write(bindings.text);
    return;
  }
  const lines = [`# ${card.type}: ${card.name}`, `ID: ${card.id}`, card.description,
    `Owner: ${card.capability ? `${card.capability.kind}:${card.capability.name}` : 'project/unowned'} | installed: ${card.installed}`, statsText(card.rule_stats as RuleStats)];
  if (pinNote) lines.push(pinNote);
  if ('activation' in card) lines.push(`Activation: ${card.activation} | enforcement: ${card.enforcement}`, `Bound targets: ${JSON.stringify(card.bound_to)}`);
  lines.push(contentNotice, bindings.text || RULE_CHECK_OBLIGATION, '\n## Outline', ...card.outline.map(section => `- ${section.heading} (${section.bytes} bytes, ${section.lines} lines)`),
    '\n## Resources', ...resources.map(resource => `- ${resource.path} (${resource.bytes} bytes)`), '\n## Drill in',
    ...Object.values(card.drill_in).flat().map(command => `- ${command}`));
  if (card.resource) lines.push(`\n## Resource: ${card.resource.path}`, card.resource.body);
  console.log(lines.join('\n'));
}

/**
 * Emit a metadata card, with opt-in body/section drill-ins for a
 * SKILL.md. Consumers don't need to know where AIWG stores skills —
 * they pass the skill name and the CLI reads the file from the indexed
 * location.
 *
 * Lookup order:
 *   1. Stable discover/Fortemi id
 *   2. Exact path match against any indexed entry's stored path
 *   3. Basename match (e.g. `intake-wizard` matches an entry whose
 *      directory basename is `intake-wizard`)
 *   4. Title match (case-insensitive)
 *   5. Corpus fallback under AIWG_ROOT (#1221)
 *
 * On ambiguity, lists all matches and exits with code 2 unless
 * `--first` is supplied.
 */
export async function showArtifact(
  cwd: string,
  params: ShowParams,
): Promise<void> {
  loadGlobalGraphConfigs();
  const { promises: fs } = await import('node:fs');
  const types = params.typeFilter && params.typeFilter.length > 0
    ? params.typeFilter
    : [...OPERATIONAL_SHOW_TYPES];
  const {
    entries,
    aiwgRoot,
    resourceSource,
    webRelease,
    relations,
  } = await loadShowEntries(cwd, params, true);

  if (entries.length === 0 && !relations && params.backend !== 'fortemi-core') {
    console.error('Error: No artifact index found.');
    console.error('Run `aiwg index build --graph framework` (or `aiwg use <framework>`) first.');
    process.exit(1);
  }

  const needle = params.name.trim();
  let matches = findShowMatches(entries, types, needle);

  if (matches.length === 0) {
    // Corpus fallback (#1221): when the artifact isn't in any indexed graph,
    // scan the AIWG_ROOT corpus for a likely match and render it with an
    // installation-aware banner. This keeps `aiwg show` useful in workspaces
    // where the operator hasn't run `aiwg use` yet, or where the framework
    // index is stale, rather than exiting with a misleading "not found".
    if (resourceSource === 'local' && aiwgRoot && params.backend !== 'fortemi-core') {
      const corpusMatch = await findCorpusArtifact(aiwgRoot, needle, types);
      if (corpusMatch) {
        let content: string;
        try {
          content = await fs.readFile(corpusMatch.path, 'utf8');
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          console.error(`Error reading ${corpusMatch.path}: ${e.message ?? String(err)}`);
          process.exit(1);
        }
        const localPin = corpusMatch.type === 'rule' ? (await import('../rules/pin-state.js')).rulePinState(cwd, aiwgRoot).rules.find(rule => rule.path === corpusMatch.path) : undefined;
        const installed = await isCorpusBundleInstalled(
          cwd, aiwgRoot, corpusMatch.bundleKind, corpusMatch.bundleId,
        );
        const installHint = installed
          ? 'The installed bundle is missing from this index. Run `aiwg index build --graph framework` to refresh it.'
          : corpusMatch.bundleKind && corpusMatch.bundleId
          ? `Run \`aiwg use ${corpusMatch.bundleId}\` to install this ${corpusMatch.bundleKind} into the workspace.`
          : 'Run `aiwg index build --graph framework` to refresh the artifact index.';
        const fallbackEntry = { path: path.relative(aiwgRoot, corpusMatch.path), type: corpusMatch.type, name: needle, title: needle } as MetadataEntry;
        const bindings = await showBindings(entries, fallbackEntry, content, params, rule => fs.readFile(resolveMetadataPath(cwd, aiwgRoot, rule), 'utf8'), relations);
        await emitShowCard(cwd, aiwgRoot, fallbackEntry,
          corpusMatch.path, content, params, bindings, { uninstalled: !installed, installed, hint: installHint,
            ...(localPin ? { local_pin: localPin } : {}) }, true);
        return;
      }
    }
    console.error(`Error: no artifact found matching "${needle}".`);
    console.error('Try `aiwg discover "<phrase>"` to find the right name.');
    process.exit(1);
  }

  // Resolve relative framework-graph paths to absolute paths.
  // Kernel entries are anchored the same way as non-kernel framework entries
  // (#1230) — show reads the source corpus, not platform deploy mirrors.
  const resolvePath = (entry: MetadataEntry) => resourceSource === 'web'
    ? `raw/${normalizeIndexedPath(entry.path)}`
    : resolveMetadataPath(cwd, aiwgRoot, entry);

  if (matches.length > 1 && !params.first) {
    if (params.json) {
      console.log(JSON.stringify({
        ambiguous: true,
        name: needle,
        matches: matches.map(e => ({
          id: discoveryIdForEntry(e),
          path: resolvePath(e),
          type: e.type,
          name: e.name,
          title: e.title,
          kernel: e.kernel ?? false,
          provenance: {
            graph: (e as ProvenancedEntry).indexGraph ?? null,
            scope: (e as ProvenancedEntry).indexScope ?? null,
            ...(webRelease
              ? {
                  resource_source: 'web',
                  aiwg_selector: webRelease.selector,
                  aiwg_version: webRelease.version,
                  manifest_sha256: webRelease.manifestDigest,
                  manifest_url: webRelease.manifestUrl,
                }
              : {}),
          },
        })),
      }, null, 2));
    } else {
      console.error(`Ambiguous: "${needle}" matches ${matches.length} artifacts. Disambiguate with --type or pass the stable id:`);
      for (const e of matches) {
        console.error(`  ${e.type.padEnd(7)} ${discoveryIdForEntry(e)} ${e.title}`);
      }
      console.error('');
      console.error('Re-run with `--first` to pick the top match, `--type skill` to filter, or `aiwg show metadata <id>` for paths.');
    }
    process.exit(2);
  }

  const entry = matches[0];
  const filePath = resolvePath(entry);
  let content: string;
  if (resourceSource === 'web') {
    try {
      if (!webRelease) throw new Error('verified web release context is unavailable');
      const { logicalIdFromFirstPartyPath, resolveAiwgResourceBytes } = await import('../resources/resolver.js');
      const logicalId = logicalIdFromFirstPartyPath(entry.path);
      if (!logicalId) throw new Error(`indexed path is not a first-party AIWG resource: ${entry.path}`);
      const resolved = await resolveAiwgResourceBytes(logicalId, {
        source: 'web',
        frameworkRoot: aiwgRoot ?? cwd,
        webRelease,
        webReleaseOptions: params.webReleaseOptions,
        offline: params.offline,
      });
      content = resolved.bytes.toString('utf8');
    } catch (error) {
      console.error(`Error: AIWG web resource show failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  } else {
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      console.error(`Error reading ${filePath}: ${e.message ?? String(err)}`);
      process.exit(1);
    }
  }

  const localPin = entry.type === 'rule' ? (await import('../rules/pin-state.js')).rulePinState(cwd, aiwgRoot ?? cwd).rules.find(rule => rule.path === filePath) : undefined;
  const bindings = await showBindings(entries, entry, content, params, async rule => {
    if (resourceSource === 'local') return fs.readFile(resolvePath(rule), 'utf8');
    const { logicalIdFromFirstPartyPath, resolveAiwgResourceBytes } = await import('../resources/resolver.js');
    const logicalId = logicalIdFromFirstPartyPath(rule.path);
    if (!logicalId || !webRelease) throw new Error(`Cannot resolve bound rule: ${rule.path}`);
    const resolved = await resolveAiwgResourceBytes(logicalId, {
      source: 'web', frameworkRoot: aiwgRoot ?? cwd, webRelease,
      webReleaseOptions: params.webReleaseOptions, offline: params.offline,
    });
    return resolved.bytes.toString('utf8');
  }, relations);

  const providerModels = resourceSource === 'local' ? await loadProviderModelMetadata(cwd, aiwgRoot) : null;
  await emitShowCard(cwd, aiwgRoot, entry, filePath, content, params, bindings, {
    provenance: {
      graph: (entry as ProvenancedEntry).indexGraph ?? null,
      scope: (entry as ProvenancedEntry).indexScope ?? null,
      ...(webRelease ? { resource_source: 'web', aiwg_selector: webRelease.selector, aiwg_version: webRelease.version,
        manifest_sha256: webRelease.manifestDigest, manifest_url: webRelease.manifestUrl } : {}),
    },
    ...(entry.script ? { executable: true, run_hint: buildRunHint(entry) } : {}),
    ...(providerModels ? { providerModels } : {}),
    ...(localPin ? { local_pin: localPin } : {}),
  }, resourceSource === 'local', webRelease);
}

export async function showMetadata(
  cwd: string,
  params: ShowMetadataParams,
): Promise<void> {
  loadGlobalGraphConfigs();
  const types = params.typeFilter && params.typeFilter.length > 0
    ? params.typeFilter
    : [...OPERATIONAL_SHOW_TYPES];
  const {
    entries,
    aiwgRoot,
    resourceSource,
    webRelease,
    sourcePaths,
  } = await loadShowEntries(cwd, params);

  if (entries.length === 0 && params.backend !== 'fortemi-core') {
    console.error('Error: No artifact index found.');
    console.error('Run `aiwg index build --graph framework` (or `aiwg use <framework>`) first.');
    process.exit(1);
  }

  const needle = params.name.trim();
  const matches = findShowMatches(entries, types, needle);

  if (matches.length === 0) {
    console.error(`Error: no artifact metadata found matching "${needle}".`);
    console.error('Try `aiwg discover "<phrase>" --json` to find the stable id.');
    process.exit(1);
  }

  const resolvePath = (entry: MetadataEntry) => resourceSource === 'web'
    ? `raw/${normalizeIndexedPath(entry.path)}`
    : resolveMetadataPath(cwd, aiwgRoot, entry);

  if (matches.length > 1 && !params.first) {
    if (params.json) {
      console.log(JSON.stringify({
        ambiguous: true,
        name: needle,
        matches: matches.map((entry) => ({
          id: discoveryIdForEntry(entry),
          type: entry.type,
          name: entry.name,
          title: entry.title,
          provenance: {
            graph: (entry as ProvenancedEntry).indexGraph ?? null,
            scope: (entry as ProvenancedEntry).indexScope ?? null,
            ...(webRelease
              ? {
                  resource_source: 'web',
                  aiwg_selector: webRelease.selector,
                  aiwg_version: webRelease.version,
                  manifest_sha256: webRelease.manifestDigest,
                  manifest_url: webRelease.manifestUrl,
                }
              : {}),
          },
        })),
      }, null, 2));
    } else {
      console.error(`Ambiguous: "${needle}" matches ${matches.length} artifacts. Disambiguate with the stable id:`);
      for (const entry of matches) {
        console.error(`  ${entry.type.padEnd(7)} ${discoveryIdForEntry(entry)} ${entry.title}`);
      }
    }
    process.exit(2);
  }

  const entry = matches[0];
  const absolutePath = resolvePath(entry);
  const backend = params.backend ?? DEFAULT_ARTIFACT_SEARCH_BACKEND;
  const record = backend === 'fortemi-core'
    ? await fortemiRecordForEntry(cwd, entry, sourcePaths)
    : null;
  const payload = {
    id: discoveryIdForEntry(entry),
    backend,
    type: entry.type,
    name: entry.name,
    title: entry.title,
    paths: {
      absolute: absolutePath,
      indexed: entry.path,
      repo_relative: record?.source.repo_relative_path ?? entry.path,
      locator: record?.source.locator ?? entry.name ?? entry.title,
    },
    provenance: {
      graph: (entry as ProvenancedEntry).indexGraph ?? null,
      scope: (entry as ProvenancedEntry).indexScope ?? null,
      ...(webRelease
        ? {
            resource_source: 'web',
            aiwg_selector: webRelease.selector,
            aiwg_version: webRelease.version,
            manifest_sha256: webRelease.manifestDigest,
            manifest_url: webRelease.manifestUrl,
          }
        : {}),
    },
    metadata: record ?? entry,
    providerModels: resourceSource === 'local'
      ? await loadProviderModelMetadata(cwd, aiwgRoot)
      : null,
  };

  if (params.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`${payload.type} ${payload.title}`);
  console.log(`  id: ${payload.id}`);
  if (payload.name) console.log(`  name: ${payload.name}`);
  console.log(`  graph: ${payload.provenance.graph ?? 'unknown'}`);
  console.log(`  scope: ${payload.provenance.scope ?? 'unknown'}`);
  console.log(`  path: ${payload.paths.absolute}`);
  console.log(`  indexed_path: ${payload.paths.indexed}`);
  if (payload.providerModels) {
    console.log('  provider_models:');
    for (const [provider, hints] of Object.entries(payload.providerModels.providers)) {
      console.log(`    ${provider}:`);
      for (const hint of hints) {
        console.log(`      ${hint.role}: ${hint.model} (wrapper: ${hint.wrapper}, status: ${hint.status})`);
      }
    }
  }
  console.log('');
  console.log(JSON.stringify(payload.metadata, null, 2));
}

function isTopLevelPersonaAgentPath(entryPath: string): boolean {
  return /(^|[/\\])agentic[/\\]code[/\\]agents[/\\]personas[/\\][^/\\]+\.md$/.test(entryPath);
}

function isCanonicalBundleAgentPath(entryPath: string): boolean {
  return /(^|[/\\])agentic[/\\]code[/\\](?:frameworks|addons|extensions|plugins)[/\\][^/\\]+[/\\]agents[/\\][^/\\]+\.md$/.test(entryPath);
}

function isCanonicalSourceAgentPath(entryPath: string): boolean {
  return /(^|[/\\])agentic[/\\]code[/\\](?:frameworks|addons|extensions)[/\\][^/\\]+[/\\]agents[/\\][^/\\]+\.md$/.test(entryPath);
}

function isFrameworkSourceSkillPath(entryPath: string): boolean {
  return /(^|[/\\])agentic[/\\]code[/\\]frameworks[/\\][^/\\]+[/\\]skills[/\\][^/\\]+[/\\]SKILL\.md$/.test(entryPath);
}

function isCanonicalSourceSkillPath(entryPath: string): boolean {
  return /(^|[/\\])agentic[/\\]code[/\\](?:frameworks|addons|extensions)[/\\][^/\\]+[/\\]skills[/\\][^/\\]+[/\\]SKILL\.md$/.test(entryPath);
}

function uniqueEntriesByPath(entries: MetadataEntry[]): MetadataEntry[] {
  const seen = new Set<string>();
  const unique: MetadataEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    unique.push(entry);
  }
  return unique;
}
