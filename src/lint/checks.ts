// Run content and frontmatter lint checks.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { LintCheck, LintDiagnostic, LintSeverity } from './types.js';
import { isRefId, refIdFromFilename } from '../research/identity.js';
import { resolvesFromBasePath } from './reference-resolution.js';
import { DEFAULT_REFERENCE_PATTERN, DEFAULT_ABSENCE_MARKERS, DEFAULT_UNCERTAINTY_PATTERNS, DEFAULT_VERIFICATION_TARGETS, DEFAULT_OBSTACLE_PATTERNS, splitClauses, strikethroughSpans, retractedWithDatedOutcome } from './check-patterns.js';

/**
 * Parse YAML-style frontmatter from a markdown file
 * Returns key-value pairs from the --- delimited block
 */
export function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};

  try {
    const parsed: unknown = parse(match[1]);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    // Invalid YAML cannot supply required metadata.
    return {};
  }
}

function isPresent(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Run a single check against a file's content and frontmatter
 */
export function runCheck(
  check: LintCheck,
  content: string,
  frontmatter: Record<string, unknown>,
  filePath: string,
  targetDir: string,
  allFiles: string[],
  referenceIndex: Set<string>,
  projectRoot: string
): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];

  switch (check.type) {
    case 'frontmatter-required': {
      if (!check.fields) break;
      for (const field of check.fields) {
        if (!isPresent(frontmatter[field])) {
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
      if (isPresent(value) && typeof value !== 'object' && !new RegExp(check.pattern).test(String(value))) {
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
          const basePaths = check.basePath
            ? [check.basePath]
            : ['.aiwg/research/findings', 'findings', 'documentation/references', '.'];
          // A corpus documents its deliberate gaps ("REF-2464 remains
          // unallocated after deduplication"). Reading that sentence as a
          // dangling reference left only two ways to silence an error: delete
          // accurate documentation, or allocate a REF that is deliberately
          // absent (#2555).
          if (absence.some((re) => re.test(lines[i]))) continue;

          if (!referenceIndex.has(refId) && !basePaths.some(basePath =>
            resolvesFromBasePath(refId, targetDir, basePath, projectRoot))) {
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
      if (isPresent(refPath)) {
        // Project-root-relative is canonical (#3145); target-relative paths
        // written for the legacy layout keep resolving.
        const found = typeof refPath === 'string' &&
          [projectRoot, targetDir].some(base => fs.existsSync(path.resolve(base, refPath)));
        if (!found) {
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
      const match = basename.match(new RegExp(check.pattern));
      if (!match) {
        diagnostics.push({
          ruleId: '',
          ruleName: '',
          severity: 'warn',
          file: filePath,
          message: `File name '${basename}' does not match expected format: ${check.pattern}`,
          fix: `Rename to match the pattern ${check.pattern}`,
        });
      } else if (check.field && isPresent(frontmatter[check.field])) {
        const identifier = match[1] ?? match[0];
        const value = frontmatter[check.field];
        if (value !== identifier) {
          diagnostics.push({
            ruleId: '',
            ruleName: '',
            severity: 'warn',
            file: filePath,
            message: `File identifier '${identifier}' does not match frontmatter field '${check.field}': ${String(value)}`,
            fix: `Make the filename identifier and '${check.field}' field agree`,
          });
        }
      }
      break;
    }

    case 'cross-ref-bidirectional': {
      const refPattern = check.referencePattern || DEFAULT_REFERENCE_PATTERN;
      const regex = new RegExp(refPattern, 'g');
      const currentBasename = refIdFromFilename(path.basename(filePath)) ?? path.basename(filePath, '.md');
      const matches = content.match(regex) || [];

      for (const ref of matches) {
        if (ref === currentBasename) continue;
        // Find the referenced file
        const refFile = allFiles.find(f => isRefId(ref)
          ? refIdFromFilename(path.basename(f)) === ref : path.basename(f, '.md') === ref);
        if (refFile) {
          try {
            const refContent = fs.readFileSync(path.resolve(targetDir, refFile), 'utf8');
            const backlinks: string[] = refContent.match(regex) ?? [];
            if (!backlinks.includes(currentBasename)) {
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

