/**
 * Lint Runner
 *
 * Core lint execution engine. Matches rules to files,
 * runs checks, and collects diagnostics.
 *
 * @issue #810
 */

import fs from 'fs';
import { spawnSync } from 'child_process';
import fsp from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import { minimatch } from 'minimatch';
import type {
  LintCheck,
  LintDiagnostic,
  LintResult,
  LintRule,
  LintRuleset,
  LintSeverity,
} from './types.js';

/**
 * Parse YAML-style frontmatter from a markdown file
 * Returns key-value pairs from the --- delimited block
 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
    if (kv) {
      result[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return result;
}

const DEFAULT_REFERENCE_PATTERN = '\\bREF-\\d{3,}\\b';

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
  '\\bdoes not exist\\b',
  '\\bno longer (?:exists|allocated)\\b',
  '\\bdeduplicat',
];

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
function splitClauses(line: string): string[] {
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
function retractedWithDatedOutcome(line: string): boolean {
  const dated = new RegExp(DATED_OUTCOME_PATTERN, 'i');
  const strikethrough = /~~([\s\S]*?)~~/g;
  let match: RegExpExecArray | null;
  while ((match = strikethrough.exec(line)) !== null) {
    if (dated.test(line.slice(match.index + match[0].length))) return true;
  }
  return false;
}

/** Character offsets of every `~~…~~` span on a line. */
function strikethroughSpans(line: string): Array<{ start: number; end: number }> {
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

/**
 * Build a target-wide artifact ID index once per lint run.
 *
 * Reference documents may use either an exact filename (`REF-001.md`) or the
 * canonical slugged form (`REF-001-some-title.md`). Indexing the ID prefix also
 * makes resolution independent of a particular corpus directory layout.
 */
function buildReferenceIndex(allFiles: string[]): Set<string> {
  const references = new Set<string>();

  for (const file of allFiles) {
    if (path.extname(file).toLowerCase() !== '.md') continue;

    const basename = path.basename(file, '.md');
    if (/^REF-\d+-(?:citations|radar)$/.test(basename)) continue;
    references.add(basename);

    const artifactId = basename.match(/^(.+?-\d+)(?:-|$)/);
    if (artifactId) references.add(artifactId[1]);
  }

  return references;
}

/**
 * Preserve support for references stored outside the lint target when a rule
 * explicitly supplies basePath. Accept both exact and slugged filenames.
 */
function resolvesFromBasePath(refId: string, targetDir: string, basePath: string): boolean {
  const candidateDirs = new Set([
    path.resolve(targetDir, basePath),
    path.resolve(process.cwd(), basePath),
  ]);

  for (const dir of candidateDirs) {
    try {
      if (fs.existsSync(path.join(dir, `${refId}.md`))) return true;
      if (fs.readdirSync(dir).some(file => file.startsWith(`${refId}-`) && file.endsWith('.md'))) {
        return true;
      }
    } catch {
      // Missing or unreadable candidate directories do not resolve the ID.
    }
  }

  return false;
}

/**
 * Run a single check against a file's content and frontmatter
 */
function runCheck(
  check: LintCheck,
  content: string,
  frontmatter: Record<string, string>,
  filePath: string,
  targetDir: string,
  allFiles: string[],
  referenceIndex: Set<string>
): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];

  switch (check.type) {
    case 'frontmatter-required': {
      if (!check.fields) break;
      for (const field of check.fields) {
        if (!frontmatter[field] || frontmatter[field].trim() === '') {
          diagnostics.push({
            ruleId: '',
            ruleName: '',
            severity: 'error',
            file: filePath,
            message: `Missing required frontmatter field: ${field}`,
            fix: `Add '${field}:' to the YAML frontmatter block`,
          });
        }
      }
      break;
    }

    case 'frontmatter-format': {
      if (!check.field || !check.pattern) break;
      const value = frontmatter[check.field];
      if (value && !new RegExp(check.pattern).test(value)) {
        diagnostics.push({
          ruleId: '',
          ruleName: '',
          severity: 'warn',
          file: filePath,
          message: `Frontmatter field '${check.field}' value '${value}' does not match pattern: ${check.pattern}`,
          fix: `Update '${check.field}' to match the expected format`,
        });
      }
      break;
    }

    case 'reference-resolves': {
      const refPattern = check.referencePattern || DEFAULT_REFERENCE_PATTERN;
      const regex = new RegExp(refPattern, 'g');
      const lines = content.split('\n');
      const absence = (check.absenceMarkers ?? DEFAULT_ABSENCE_MARKERS).map((p) => new RegExp(p, 'i'));

      for (let i = 0; i < lines.length; i++) {
        let match;
        while ((match = regex.exec(lines[i])) !== null) {
          const refId = match[0];
          const basePath = check.basePath || '.aiwg/research/findings';
          // A corpus documents its deliberate gaps ("REF-2464 remains
          // unallocated after deduplication"). Reading that sentence as a
          // dangling reference left only two ways to silence an error: delete
          // accurate documentation, or allocate a REF that is deliberately
          // absent (#2555).
          if (absence.some((re) => re.test(lines[i]))) continue;

          if (!referenceIndex.has(refId) && !resolvesFromBasePath(refId, targetDir, basePath)) {
            diagnostics.push({
              ruleId: '',
              ruleName: '',
              severity: 'error',
              file: filePath,
              message: `Reference '${refId}' does not resolve to an existing file`,
              line: i + 1,
            });
          }
        }
      }
      break;
    }

    case 'unregistered-uncertainty': {
      // An uncertainty written only into prose is invisible to the verification
      // contract: it was never a declared check, so it never surfaces as
      // `incomplete` and the "never report skipped verification as success" rule
      // is never violated. Flag the bare form; accept it once a specific
      // obstacle is named or an outcome is recorded (#2523).
      const uncertainty = (check.uncertaintyPatterns ?? DEFAULT_UNCERTAINTY_PATTERNS)
        .map((p) => new RegExp(p, 'i'));
      const targets = (check.verificationTargets ?? DEFAULT_VERIFICATION_TARGETS)
        .map((p) => new RegExp(p, 'i'));
      const obstacle = (check.obstaclePatterns ?? DEFAULT_OBSTACLE_PATTERNS)
        .map((p) => new RegExp(p, 'i'));
      const within = check.obstacleWithinLines ?? 2;
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        // Both conditions must hold in the SAME CLAUSE: an unperformed action
        // AND something the agent could have acted on. Without the target, the
        // match is as likely to be the paper's own limitation, which must stay
        // untouched. Without clause scoping, a long markdown line relates two
        // unrelated clauses — real corpus prose puts whole paragraphs and
        // changelog tables on one line, which produced most false positives.
        const clause = splitClauses(lines[i]).find((c) =>
          uncertainty.some((re) => re.test(c)) && targets.some((re) => re.test(c)));
        if (!clause) continue;
        // A struck span followed by a dated outcome is a completed retraction,
        // whatever its length. Clause scoping otherwise ends the window before
        // the `**Done <date>**` that closes it, so the recommended convention
        // failed for two-sentence struck text and passed for one (#2556).
        const clauseAt = lines[i].indexOf(clause);
        const struck = clauseAt >= 0 && strikethroughSpans(lines[i])
          .some((span) => clauseAt >= span.start && clauseAt < span.end);
        if (struck && retractedWithDatedOutcome(lines[i])) continue;
        // Look in the matching line and the following `within` lines: the
        // obstacle normally sits in the same sentence or the next one.
        const window = lines.slice(i, i + within + 1).join(' ');
        if (obstacle.some((re) => re.test(window))) continue;
        diagnostics.push({
          ruleId: '',
          ruleName: '',
          // Left unset so the rule's declared severity applies (see runRule).
          // This is a prose heuristic, so the shipped rule declares `warn`; an
          // operator can raise it to error once a corpus is clean.
          severity: undefined as unknown as LintSeverity,
          file: filePath,
          line: i + 1,
          message: `Uncertainty stated without a named obstacle or recorded outcome: ${clause.trim().slice(0, 160)}`,
          fix: 'Resolve it if it costs about one request against a known endpoint, or name the specific obstacle (HTTP status, credential required, rate limited, paywalled) so it lands as incomplete/blocked rather than narrative. If the check has since been done, retract the statement with the dated form — `~~<original limitation>~~ **Done YYYY-MM-DD (<what closed it>).** <evidence>` — which closes it whatever the length of the struck text.',
        });
      }
      break;
    }

    case 'pattern-match': {
      if (!check.pattern) break;
      const regex = new RegExp(check.pattern);
      if (!regex.test(content)) {
        diagnostics.push({
          ruleId: '',
          ruleName: '',
          severity: 'warn',
          file: filePath,
          message: `File content does not match expected pattern: ${check.pattern}`,
        });
      }
      break;
    }

    case 'file-exists': {
      if (!check.field) break;
      const refPath = frontmatter[check.field];
      if (refPath) {
        const resolved = path.resolve(targetDir, refPath);
        if (!fs.existsSync(resolved)) {
          diagnostics.push({
            ruleId: '',
            ruleName: '',
            severity: 'error',
            file: filePath,
            message: `Referenced file '${refPath}' (from field '${check.field}') does not exist`,
          });
        }
      }
      break;
    }

    case 'id-unique': {
      // Handled at ruleset level in runRule
      break;
    }

    case 'id-format': {
      if (!check.pattern) break;
      const basename = path.basename(filePath, '.md');
      if (!new RegExp(check.pattern).test(basename)) {
        diagnostics.push({
          ruleId: '',
          ruleName: '',
          severity: 'warn',
          file: filePath,
          message: `File name '${basename}' does not match expected format: ${check.pattern}`,
          fix: `Rename to match the pattern ${check.pattern}`,
        });
      }
      break;
    }

    case 'cross-ref-bidirectional': {
      const refPattern = check.referencePattern || DEFAULT_REFERENCE_PATTERN;
      const regex = new RegExp(refPattern, 'g');
      const currentBasename = path.basename(filePath, '.md');
      const matches = content.match(regex) || [];

      for (const ref of matches) {
        if (ref === currentBasename) continue;
        // Find the referenced file
        const refFile = allFiles.find(f => path.basename(f, '.md') === ref);
        if (refFile) {
          try {
            const refContent = fs.readFileSync(path.resolve(targetDir, refFile), 'utf8');
            if (!refContent.includes(currentBasename)) {
              diagnostics.push({
                ruleId: '',
                ruleName: '',
                severity: 'info',
                file: filePath,
                message: `References '${ref}' but '${ref}' does not reference back to '${currentBasename}'`,
                fix: `Add a cross-reference to '${currentBasename}' in ${ref}.md`,
              });
            }
          } catch {
            // Skip if can't read
          }
        }
      }
      break;
    }
  }

  return diagnostics;
}

/**
 * Candidate paths a rule glob may be written against (#2555).
 *
 * `collectFiles` walks with `cwd: targetDir`, so files arrive target-relative
 * (`REF-001.md`) while rule globs are written repo-relative
 * (`documentation/references/**\/*.md`). Narrowing the target to the very
 * directory a rule names therefore matched nothing, and the run reported PASS
 * with every finding unreported. Matching against the target-relative path and
 * each ancestor-prefixed form makes a glob resolve the same way wherever the
 * walk is rooted.
 */
export function ruleMatchCandidates(file: string, targetDir: string): string[] {
  const normalizedFile = file.replace(/\\/g, '/');
  const candidates = [normalizedFile];
  const segments = path.resolve(targetDir).replace(/\\/g, '/').split('/').filter(Boolean);
  let prefix = '';
  for (let i = segments.length - 1; i >= 0 && segments.length - i <= 12; i -= 1) {
    prefix = prefix ? `${segments[i]}/${prefix}` : `${segments[i]}/`;
    candidates.push(`${prefix}${normalizedFile}`);
  }
  return candidates;
}

/** True when a rule's glob selects this file, wherever the walk was rooted. */
export function ruleAppliesToFile(ruleGlob: string, file: string, targetDir: string): boolean {
  return ruleMatchCandidates(file, targetDir).some((candidate) => minimatch(candidate, ruleGlob));
}

/**
 * Run a single rule against all matching files in the target
 */
async function runRule(
  rule: LintRule,
  targetDir: string,
  allFiles: string[],
  referenceIndex: Set<string>
): Promise<LintDiagnostic[]> {
  const diagnostics: LintDiagnostic[] = [];
  RULE_APPLIED.delete(rule.id);

  // Filter files matching the rule's glob
  const ruleGlob = rule.appliesTo.glob;
  const matchingFiles = allFiles.filter(f => ruleAppliesToFile(ruleGlob, f, targetDir));

  if (matchingFiles.length === 0) return diagnostics;
  RULE_APPLIED.add(rule.id);

  // Handle id-unique check at the ruleset level
  const uniqueCheck = rule.checks.find(c => c.type === 'id-unique');
  if (uniqueCheck) {
    const ids = new Map<string, string>();
    for (const file of matchingFiles) {
      const basename = path.basename(file, '.md');
      if (ids.has(basename)) {
        diagnostics.push({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          file,
          message: `Duplicate identifier '${basename}' — also found in ${ids.get(basename)}`,
        });
      } else {
        ids.set(basename, file);
      }
    }
  }

  // Run per-file checks
  for (const file of matchingFiles) {
    const absPath = path.resolve(targetDir, file);
    let content: string;
    try {
      content = await fsp.readFile(absPath, 'utf8');
    } catch {
      continue;
    }

    const frontmatter = parseFrontmatter(content);

    for (const check of rule.checks) {
      if (check.type === 'id-unique') continue; // Already handled

      const checkDiagnostics = runCheck(
        check,
        content,
        frontmatter,
        file,
        targetDir,
        allFiles,
        referenceIndex
      );
      for (const d of checkDiagnostics) {
        d.ruleId = rule.id;
        d.ruleName = rule.name;
        d.severity = d.severity || rule.severity;
        diagnostics.push(d);
      }
    }
  }

  return diagnostics;
}

/** Rule ids that selected at least one file in the current run (#2555). */
const RULE_APPLIED = new Set<string>();

/**
 * Collect all files under a target directory
 */
async function collectFiles(
  targetDir: string,
  recursive: boolean,
  respectGitignore = true,
): Promise<string[]> {
  const pattern = recursive ? '**/*' : '*';
  try {
    const files = await glob(pattern, {
      cwd: targetDir,
      nodir: true,
      dot: false,
    });
    const linted = files.filter(f => f.endsWith('.md') || f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json'));
    return respectGitignore ? dropGitignored(targetDir, linted) : linted;
  } catch {
    return [];
  }
}

/**
 * Drop files git ignores (#2555).
 *
 * Generated trees are regenerated, not authored: linting `indices/` reported an
 * error in text that documents a deliberate gap. `git check-ignore` is asked
 * once for the whole set so the semantics are git's own (negations, nested
 * `.gitignore`, `core.excludesFile`) rather than a re-implementation. Outside a
 * repository, or without git, every file is kept.
 */
function dropGitignored(targetDir: string, files: string[]): string[] {
  if (files.length === 0) return files;
  try {
    const result = spawnSync('git', ['check-ignore', '--stdin'], {
      cwd: targetDir,
      input: `${files.join('\n')}\n`,
      encoding: 'utf8',
    });
    // 0 = some paths ignored, 1 = none ignored, anything else = not a repo or
    // git unavailable, in which case nothing is filtered.
    if (result.error || (result.status !== 0 && result.status !== 1)) return files;
    const ignored = new Set(
      (result.stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
    );
    if (ignored.size === 0) return files;
    return files.filter((file) => !ignored.has(file));
  } catch {
    return files;
  }
}

/**
 * Auto-detect which rulesets apply to a target path
 *
 * Maps known directory patterns to rulesets:
 * - .aiwg/research/ → research-complete
 * - .aiwg/requirements/, .aiwg/architecture/ → sdlc-complete
 */
function autoDetectRulesets(target: string, available: LintRuleset[]): LintRuleset[] {
  const normalized = target.replace(/\\/g, '/');

  const matches: LintRuleset[] = [];
  for (const rs of available) {
    // Match by framework ID patterns
    if (normalized.includes('research') && rs.framework.includes('research')) {
      matches.push(rs);
    } else if (
      (normalized.includes('requirements') ||
        normalized.includes('architecture') ||
        normalized.includes('testing') ||
        normalized.includes('deployment')) &&
      rs.framework.includes('sdlc')
    ) {
      matches.push(rs);
    }
  }

  // If no auto-detection, return all available
  return matches.length > 0 ? matches : available;
}

/**
 * Run lint on a target path with specified or auto-detected rulesets
 */
export async function runLint(
  targetDir: string,
  rulesets: LintRuleset[],
  options: { recursive?: boolean; failOn?: LintSeverity; respectGitignore?: boolean } = {}
): Promise<LintResult> {
  const recursive = options.recursive ?? true;
  const allFiles = await collectFiles(targetDir, recursive, options.respectGitignore ?? true);
  const referenceIndex = buildReferenceIndex(allFiles);
  const allDiagnostics: LintDiagnostic[] = [];
  const inapplicableRules: string[] = [];
  let rulesSelected = 0;

  for (const ruleset of rulesets) {
    for (const rule of ruleset.rules) {
      rulesSelected += 1;
      const diagnostics = await runRule(rule, targetDir, allFiles, referenceIndex);
      if (!RULE_APPLIED.has(rule.id)) inapplicableRules.push(rule.id);
      allDiagnostics.push(...diagnostics);
    }
  }

  const errors = allDiagnostics.filter(d => d.severity === 'error').length;
  const warnings = allDiagnostics.filter(d => d.severity === 'warn').length;
  const infos = allDiagnostics.filter(d => d.severity === 'info').length;

  const failOn = options.failOn || 'error';
  let passed = true;
  if (failOn === 'error' && errors > 0) passed = false;
  if (failOn === 'warn' && (errors > 0 || warnings > 0)) passed = false;
  if (failOn === 'info' && allDiagnostics.length > 0) passed = false;

  return {
    target: targetDir,
    rulesets: rulesets.map(r => r.id),
    diagnostics: allDiagnostics,
    summary: {
      filesChecked: allFiles.length,
      errors,
      warnings,
      infos,
      passed,
      // A run where no rule selected a file must never read the same as a clean
      // run (#2555). Reporters surface this; callers can gate on it.
      rulesSelected,
      rulesApplied: rulesSelected - inapplicableRules.length,
      inapplicableRules,
    },
    timestamp: new Date().toISOString(),
  };
}

export { autoDetectRulesets };
