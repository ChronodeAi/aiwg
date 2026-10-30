// Shared lint patterns and clause helpers.
import { REF_ID_PATTERN } from '../research/identity.js';

export const DEFAULT_REFERENCE_PATTERN = REF_ID_PATTERN;

/**
 * Phrases that mark an identifier as deliberately absent (#2555). A mention
 * next to one of these documents a gap rather than pointing at a document, so
 * it is not an unresolved reference.
 */
export const DEFAULT_ABSENCE_MARKERS = [
  '\\bunallocated\\b',
  '\\bnot in corpus\\b',
  '\\bskipped\\b',
  '\\bretired\\b',
  '\\bwithdrawn\\b',
  '\\bdeliberately (?:absent|unallocated|skipped)\\b',
  '\\bnever (?:allocated|assigned)\\b',
  '\\bdeduplicat',
];
// Deliberately NOT markers: "does not exist", "missing", "no longer exists".
// Those are how a broken reference is described, not how a corpus records an
// intentional gap, and treating them as markers would suppress the finding this
// check exists for.

/**
 * Verification targets — things the inducting agent could have checked.
 *
 * Requiring one of these is what separates "the agent skipped a cheap check"
 * from "the paper's own claim is unverified". Only the first is a provenance
 * gap; the second is legitimate analysis, and #2523 explicitly does not ask
 * agents to stop declaring limitations. Validated against a 2,544-reference
 * corpus, where grammar-only matching made ~45% of hits paper-claim prose
 * ("scaling behavior above 7B is unverified", "Not confirmed (34% vs 51%)").
 */
/**
 * Split a markdown line into clauses.
 *
 * Corpus prose keeps whole paragraphs, bullet bodies and changelog table rows on
 * a single line, so "same line" is far too coarse a scope for relating an
 * unperformed action to its target. Sentence and cell boundaries are the unit
 * that actually corresponds to one statement.
 */
export function splitClauses(line: string): string[] {
  return line
    .split(/(?<=[.;:!?])\s+|\s+\u2014\s+|\s+--\s+|\|/g)
    .map((c) => c.trim())
    .filter(Boolean);
}

export const DEFAULT_VERIFICATION_TARGETS = [
  'openreview',
  '(?:acl )?anthology',
  'proceedings',
  'camera[- ]ready',
  'published version',
  '\\bPMLR\\b',
  '\\bDBLP\\b',
  '\\bOpenAlex\\b',
  'semantic scholar',
  '\\bpubpeer\\b',
  '\\bunpaywall\\b',
  'retraction|correction notice|expression of concern',
  'citation (?:census|count)',
  'influential citation',
  '\\bPDF\\b',
  'full[- ]text',
  '\\be-?print\\b',
  '(?:code|project|dataset|repository|repo)\\s+(?:page|url|link|release|availability)',
  '\\bvenue\\b',
  '\\bacceptance\\b',
  'source[_ ]type',
];

/**
 * Phrases that assert a check was not performed. Drawn from real induction
 * output — each of these has appeared in a corpus reference doc (#2523).
 * Only counted when a verification target appears on the same line.
 */
export const DEFAULT_UNCERTAINTY_PATTERNS = [
  '(?:was|were|is|are) not (?:retrieved|run|performed|attempted|fetched|queried|checked|acquired|probed|verified|confirmed)',
  'not (?:retrieved|run|performed|attempted|fetched|queried|checked|acquired|probed|verified|confirmed)\\b',
  // Requires the action to be stated as unperformed. Without the trailing verb
  // this matched bare "no search" in unrelated prose and scope statements like
  // "no exhaustive census is claimed", neither of which is a skipped check.
  'no (?:\\w+[ -]){0,4}(?:quer(?:y|ies)|search|census|fetch|check|lookup|probe)(?:es|s)?\\s+(?:was |were )?(?:performed|run|attempted|made|conducted|executed)',
  '\\b(?:is|remains) unverified\\b',
  '\\bunconfirmed\\b',
  'rests on .{0,60} rather than an independent',
];

/**
 * A dated outcome closes an uncertainty (#2523's "records an outcome with a
 * date"). The vocabulary is deliberately wider than a verb+date pair: the
 * retraction convention recommended alongside this rule writes
 * `~~<limitation>~~ **Done YYYY-MM-DD (<what closed it>).**`, which no
 * verb+date pattern matches, so a correctly dated retraction was rejected for
 * its shape (#2556).
 */
export const DATED_OUTCOME_PATTERN =
  '(?:\\b(?:done|resolved|completed|closed|addressed|fixed|verified|retrieved|archived|queried|fetched|checked|probed|confirmed)\\b[^\\n]{0,60}?\\d{4}-\\d{2}-\\d{2}|\\d{4}-\\d{2}-\\d{2}[^\\n]{0,30}?\\b(?:done|resolved|completed|closed|addressed|fixed)\\b)';

/**
 * The closure half of {@link DATED_OUTCOME_PATTERN}. Only explicit closure
 * verbs count outside a struck span: a date sitting anywhere near an action
 * verb ("...was not retrieved at induction. Induction ran 2026-09-01.") is not
 * an outcome, and treating it as one would discharge the very statements this
 * rule exists to catch.
 */
export const CLOSURE_OUTCOME_PATTERN =
  '(?:\\b(?:done|resolved|completed|closed|addressed|fixed)\\b[^\\n]{0,60}?\\d{4}-\\d{2}-\\d{2}|\\d{4}-\\d{2}-\\d{2}[^\\n]{0,30}?\\b(?:done|resolved|completed|closed|addressed|fixed)\\b)';

/**
 * Spans struck through with `~~…~~` are, by the markup's own meaning, no longer
 * asserted. When a dated outcome follows the span on the same line, the pair is
 * a completed retraction however long the struck text is — the length of the
 * struck span was the hidden variable behind #2556.
 */
export function retractedWithDatedOutcome(line: string): boolean {
  const dated = new RegExp(DATED_OUTCOME_PATTERN, 'i');
  const strikethrough = /~~([\s\S]*?)~~/g;
  let match: RegExpExecArray | null;
  while ((match = strikethrough.exec(line)) !== null) {
    if (dated.test(line.slice(match.index + match[0].length))) return true;
  }
  return false;
}

/** Character offsets of every `~~…~~` span on a line. */
export function strikethroughSpans(line: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const strikethrough = /~~([\s\S]*?)~~/g;
  let match: RegExpExecArray | null;
  while ((match = strikethrough.exec(line)) !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

export const DEFAULT_OBSTACLE_PATTERNS = [
  '\\bHTTP\\s?[45]\\d{2}\\b',
  '\\b(?:401|403|404|429|451|503)\\b',
  'paywall',
  'closed[- ]access',
  'requires? (?:a )?(?:credential|token|API key|subscription|login|account)',
  '\\b(?:HF_TOKEN|API[_ ]KEY)\\b',
  'rate[- ]limit',
  'anti[- ]bot',
  'cloudflare',
  'captcha',
  'endpoint unknown',
  'no (?:known )?endpoint',
  // Obstacle vocabulary observed in a real corpus: these are named obstacles,
  // so the statement is already a real outcome rather than a silent skip.
  'proof[- ]of[- ]work',
  'challenge (?:artifact|page|response)',
  'returned challenge',
  '\\bgated\\b',
  'did not render',
  'green OA',
  // Explicit scope declarations: saying what is deliberately not claimed is an
  // outcome, unlike omitting the check and not saying so.
  'is not (?:claimed|asserted)',
  'NOT (?:recorded|asserted) as',
  'evidence boundary',
  'completion_evidence',
  'status:\\s*(?:incomplete|blocked)',
  '\\b(?:queried|fetched|checked|probed|confirmed|resolved)\\s+(?:on\\s+)?\\d{4}-\\d{2}-\\d{2}',
  '\\bdeferred\\b.{0,40}\\b(?:because|since|due to)\\b',
  // An explicit dated closure ("**Done 2026-09-12 (post-induction audit).**"),
  // which the verb+date pattern above does not match (#2556).
  CLOSURE_OUTCOME_PATTERN,
];

