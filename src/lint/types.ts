/**
 * Lint System Types
 *
 * Defines interfaces for lint rules, rulesets, results, and configuration.
 * Rules are declarative YAML; the runner evaluates them against target files.
 *
 * @issue #810
 */

/**
 * Severity levels for lint rules and diagnostics
 */
export type LintSeverity = 'error' | 'warn' | 'info';

/**
 * Output format for lint results
 */
export type LintOutputFormat = 'full' | 'summary' | 'json';

/**
 * A single lint check within a rule
 */
export interface LintCheck {
  /** Check type */
  type:
    | 'frontmatter-required'
    | 'frontmatter-format'
    | 'reference-resolves'
    | 'pattern-match'
    | 'file-exists'
    | 'id-unique'
    | 'id-format'
    | 'cross-ref-bidirectional'
    | 'unregistered-uncertainty';

  /** Fields to check (for frontmatter checks) */
  fields?: string[];

  /** Specific field name (for single-field checks) */
  field?: string;

  /** Regex pattern (for format/pattern checks) */
  pattern?: string;

  /** Reference pattern to extract and resolve (for reference checks) */
  referencePattern?: string;

  /** Base directory for resolving references */
  basePath?: string;

  /** Section name that should contain cross-references */
  section?: string;

  /**
   * Phrases that state an unperformed check, for `unregistered-uncertainty`.
   * Matched case-insensitively. Defaults to the induction set when omitted.
   */
  uncertaintyPatterns?: string[];

  /**
   * Things the agent could have checked (OpenReview, camera-ready, PDF, census,
   * code URL, venue...). Required on the same line as the uncertainty phrase, so
   * a paper's own unverified claim is not mistaken for a skipped check.
   */
  verificationTargets?: string[];

  /**
   * Patterns that discharge an uncertainty by naming a specific obstacle or
   * recording an outcome (HTTP status, credential requirement, rate limit,
   * paywall, or a declared check with evidence). Defaults to a general set.
   */
  obstaclePatterns?: string[];

  /**
   * Maximum character distance between the uncertainty phrase and its
   * verification target. Markdown keeps whole paragraphs on one line, so
   * same-line co-occurrence alone relates unrelated clauses. Default 80.
   */
  targetProximity?: number;

  /**
   * How many lines after an uncertainty may carry its obstacle. Default 2 —
   * the obstacle normally sits in the same sentence or the next one.
   */
  obstacleWithinLines?: number;
}

/**
 * A declarative lint rule definition (loaded from YAML)
 */
export interface LintRule {
  /** Rule identifier (e.g., 'research/ref-frontmatter') */
  id: string;

  /** Human-readable rule name */
  name: string;

  /** Description of what the rule checks */
  description: string;

  /** Severity: error, warn, or info */
  severity: LintSeverity;

  /** File targeting — which files this rule applies to */
  appliesTo: {
    /** Glob pattern relative to lint target */
    glob: string;
  };

  /** Checks to perform on matching files */
  checks: LintCheck[];
}

/**
 * A ruleset definition (loaded from ruleset.yaml)
 */
export interface LintRuleset {
  /** Ruleset identifier (e.g., 'research') */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description */
  description: string;

  /** Framework that owns this ruleset */
  framework: string;

  /** Version */
  version: string;

  /** Individual rules in this ruleset */
  rules: LintRule[];
}

/**
 * A single lint diagnostic (violation or info)
 */
export interface LintDiagnostic {
  /** Rule that produced this diagnostic */
  ruleId: string;

  /** Rule name */
  ruleName: string;

  /** Severity */
  severity: LintSeverity;

  /** File path (relative to target) */
  file: string;

  /** Human-readable message */
  message: string;

  /** Line number (if applicable) */
  line?: number;

  /** Suggested fix (if available) */
  fix?: string;
}

/**
 * Result of a lint run
 */
export interface LintResult {
  /** Target path that was linted */
  target: string;

  /** Rulesets that were applied */
  rulesets: string[];

  /** All diagnostics */
  diagnostics: LintDiagnostic[];

  /** Summary counts */
  summary: {
    filesChecked: number;
    errors: number;
    warnings: number;
    infos: number;
    passed: boolean;
  };

  /** Timestamp */
  timestamp: string;
}

/**
 * CLI options for the lint command
 */
export interface LintOptions {
  /** Target path to lint */
  target: string;

  /** Explicit ruleset(s) to apply */
  rulesets?: string[];

  /** Recursive directory scan */
  recursive?: boolean;

  /** Output format */
  format?: LintOutputFormat;

  /** CI mode — exit code reflects pass/fail */
  ci?: boolean;

  /** Fail threshold for CI mode */
  failOn?: LintSeverity;

  /** Dry run — show what would be checked */
  dryRun?: boolean;

  /** List available rulesets */
  listRulesets?: boolean;

  /** List rules in a specific ruleset */
  listRules?: string;
}
