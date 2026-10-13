/**
 * AIWG CLI Environment Detection
 *
 * Centralized helpers for detecting the runtime environment so handlers
 * can make consistent interactive / non-interactive decisions.
 *
 * Phase 3 of the CLI Stabilization Epic (#920).
 */

/**
 * Return true iff the CLI is running attached to an interactive terminal
 * where it is safe to prompt the user.
 *
 * Conditions (all must hold):
 *   - stdin  is a TTY
 *   - stdout is a TTY
 *   - TERM is not 'dumb'
 *   - CI env var is not truthy (matches GitHub Actions, GitLab, CircleCI,
 *     Travis, Buildkite, Jenkins, and most other CI systems)
 *   - DEBIAN_FRONTEND is not 'noninteractive' (common in Docker images)
 *
 * Respects common CI convention: any of
 *   CI, CONTINUOUS_INTEGRATION, BUILD_NUMBER, RUN_ID, GITHUB_ACTIONS,
 *   GITLAB_CI, CIRCLECI, TRAVIS, BUILDKITE, JENKINS_URL
 * set (to any truthy value) indicates a CI environment.
 *
 * Handlers MUST call this helper instead of re-deriving the check locally.
 * Divergent isTTY checks scattered across handlers have caused bugs in the
 * past (#918 audit findings, and #3062 review item 12: `init` only checked
 * `CI === 'true'`, `setup project` ignored CI/TERM entirely, and `session`
 * ignored its own `--non-interactive` flag — each reinventing a narrower
 * version of this same check instead of using it).
 *
 * @param explicitNonInteractive When `true`, short-circuits to `false`
 *   without inspecting the environment at all. Pass the caller's own
 *   explicit non-interactive flag here (e.g. `--non-interactive`, or
 *   `--yes` where it means "don't prompt") so the single interactive
 *   decision takes the command's explicit flags as input, rather than
 *   every call site re-deriving its own mix of flag-vs-environment
 *   precedence. Omit it (or pass `false`) to fall through to the
 *   environment-only checks below, unchanged from before this parameter
 *   existed.
 */
export function isInteractive(explicitNonInteractive = false): boolean {
  if (explicitNonInteractive) return false;
  if (!process.stdin.isTTY) return false;
  if (!process.stdout.isTTY) return false;
  if (process.env['TERM'] === 'dumb') return false;
  if (process.env['DEBIAN_FRONTEND'] === 'noninteractive') return false;
  if (isCI()) return false;
  return true;
}

/**
 * Variables that mark a continuous-integration environment. Exported so tests
 * that need the interactive path can clear exactly what `isCI()` reads.
 */
export const CI_ENV_VARS: readonly string[] = [
  'CI',
  'CONTINUOUS_INTEGRATION',
  'BUILD_NUMBER',
  'RUN_ID',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'JENKINS_URL',
  'TF_BUILD', // Azure DevOps
  'TEAMCITY_VERSION',
];

/** Other variables `isInteractive()` reads. */
export const INTERACTIVE_ENV_VARS: readonly string[] = ['TERM', 'DEBIAN_FRONTEND'];

/**
 * Return true iff we're running in a continuous-integration environment.
 * Checks the common CI env vars set by major CI systems.
 */
export function isCI(): boolean {
  const ciVars = CI_ENV_VARS;
  for (const v of ciVars) {
    const val = process.env[v];
    if (val && val !== '0' && val.toLowerCase() !== 'false') return true;
  }
  return false;
}

/**
 * Return true iff colored output should be emitted.
 *
 * Honors NO_COLOR (per https://no-color.org) and FORCE_COLOR.
 * Requires stdout (or the passed stream) to be a TTY.
 */
export function shouldUseColor(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env['NO_COLOR']) return false;
  if (process.env['FORCE_COLOR'] && process.env['FORCE_COLOR'] !== '0') return true;
  return !!stream.isTTY;
}
