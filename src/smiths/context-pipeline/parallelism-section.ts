/**
 * Parallelism Cap Section — context-file injector
 *
 * Generates the markdown section that surfaces the project's
 * `.aiwg/aiwg.config` `parallelism` cap in regenerated context files
 * (AIWG.md, CLAUDE.md, AGENTS.md). Agents read context at session start;
 * having the cap inline means no extra IO every session.
 *
 * Wrapped in managed-block markers so future regenerations replace the
 * section in-place without disturbing operator additions outside it.
 *
 * Env var `AIWG_HIDE_PARALLELISM_IN_CONTEXT=1` suppresses injection.
 *
 * @implements #1362
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageRoot } from '../../cli/find-package-root.js';
import { readAiwgConfig, resolveParallelism, PROVIDER_PARALLELISM_DEFAULTS, type AiwgConfig, type ParallelismConfig, type WorkerGroup } from '../../config/aiwg-config.js';

export const PARALLELISM_BLOCK_START = '<!-- AIWG-PARALLELISM-CAP:START -->';
export const PARALLELISM_BLOCK_END = '<!-- AIWG-PARALLELISM-CAP:END -->';

/**
 * One-line note rendered when the bundled model defaults cannot be loaded.
 * The orchestration health block is omitted; the rest of the section renders
 * unchanged so context regeneration never throws for a missing home install.
 */
export const PARALLELISM_HEALTH_UNRESOLVED_NOTE =
  'Health values could not be resolved from the bundled defaults, so the orchestration health block is omitted.';

/** Injectable loaders for `buildParallelismSection` (tests inject failures). */
export interface ParallelismSectionDeps {
  readConfig?: (projectPath: string) => Promise<AiwgConfig | null>;
}

/**
 * Locate this package's bundled AIWG defaults (`models-v2.json` under
 * `agentic/...`) from the running code, whether it runs from a source
 * checkout or an installed package. Uses the canonical package-root walk
 * shared with the rest of src/ (`findPackageRoot`), never a hand-rolled
 * relative path and never the user's home install.
 */
function resolveBundledAiwgHome(): string | undefined {
  try {
    return findPackageRoot(dirname(fileURLToPath(import.meta.url))) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * `readAiwgConfig` with a bundled-defaults fallback: when `AIWG_HOME` is
 * unset, the model config loader resolves its defaults from this package
 * instead of the user's home, so regeneration does not depend on what is
 * installed there. An explicitly set `AIWG_HOME` always wins, and the
 * fallback is removed before returning.
 */
async function readConfigWithBundledDefaults(projectPath: string): Promise<AiwgConfig | null> {
  if (process.env.AIWG_HOME) return readAiwgConfig(projectPath);
  const bundled = resolveBundledAiwgHome();
  if (!bundled) return readAiwgConfig(projectPath);
  process.env.AIWG_HOME = bundled;
  try {
    return await readAiwgConfig(projectPath);
  } finally {
    delete process.env.AIWG_HOME;
  }
}

function isBundledDefaultsFailure(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Failed to load AIWG default config');
}

function oneLine(value: string, maxLen: number): string {
  return value.replace(/[\r\n|]+/g, ' ').trim().slice(0, maxLen);
}

/** At most this many group summaries render; the rest collapse to "+N more". */
export const MAX_SHOWN_GROUPS = 8;

/**
 * Config-level dispatchability for one group, mirroring the static gates in
 * `resolveWorkerPlan()` (`src/models/resolver.ts`): members or installations
 * flagged `enabled: false` are denied, and every `requiredRoles` entry must
 * be covered by an enabled member. Returns a "not eligible" reason, or null
 * when the group is dispatchable. Live adapter qualification still happens
 * per request inside `aiwg models resolve`, so "configured" never promises
 * a launchable worker — only that dispatch may consider the group.
 */
function groupIneligibility(parallelism: ParallelismConfig | undefined, group: WorkerGroup): string | null {
  const reasons: string[] = [];
  for (const member of group.members) {
    if (member.enabled === false) reasons.push(`member ${member.id} is disabled`);
    else if (parallelism?.clis?.[member.cli]?.enabled === false) reasons.push(`installation ${member.cli} is disabled`);
  }
  for (const role of group.requiredRoles ?? []) {
    const covered = group.members.some(m => m.enabled !== false
      && parallelism?.clis?.[m.cli]?.enabled !== false && m.roles.includes(role));
    if (!covered) reasons.push(`no enabled member covers required role ${role}`);
  }
  return reasons.length ? reasons.join('; ') : null;
}

function groupSummaries(entries: Array<[string, WorkerGroup]>, parallelism: ParallelismConfig | undefined): string[] {
  return entries.map(([id, group]) => {
    const roles = [...new Set(group.members.flatMap(m => m.roles ?? []))].join('/');
    const clis = [...new Set(group.members.map(m => m.cli))].join('/');
    const parts = [`${oneLine(id, 64)} (members: ${group.members.length}`];
    if (clis) parts.push(`clis: ${oneLine(clis, 96)}`);
    if (roles) parts.push(`roles: ${oneLine(roles, 96)}`);
    if (group.maxParallel !== undefined) parts.push(`maxParallel: ${group.maxParallel}`);
    if (group.requiredRoles?.length) parts.push(`requiredRoles: ${group.requiredRoles.join('/')}`);
    const ineligibility = groupIneligibility(parallelism, group);
    parts.push(ineligibility ? `configured — not eligible: ${oneLine(ineligibility, 160)}` : 'eligible');
    return parts.join('; ') + ')';
  });
}

/**
 * One configured health window with its origin. The origin mirrors
 * `resolveWorkerEffectiveHealth()` (`src/serve/worker-invocation.ts`): a
 * field the project config leaves unset resolves from the built-in defaults.
 */
function healthValue(health: ParallelismConfig['health'],
  field: 'checkSeconds' | 'startupSeconds' | 'quietSeconds' | 'stallSeconds' | 'hardTimeoutSeconds',
  fallback: number): { value: number; origin: string } {
  const value = health?.[field] ?? fallback;
  return { value, origin: health?.[field] === undefined ? 'default' : 'project config' };
}

function delegationSupport(provider: string | undefined): string {
  switch (provider) {
    case 'antigravity':
      return '**Provider behavior (antigravity)**: AIWG team execution uses aiwg-mc emulation. The conservative cap is four workers; native Antigravity subagent limits and heterogeneous model pinning remain unqualified.';
    case 'claude':
    case 'codex':
    case 'copilot':
    case 'cursor':
    case 'factory':
    case 'opencode':
    case 'openclaw':
      return `**Provider behavior (${provider})**: native custom subagents can select the deployed model-worker wrapper. Verify the resolved model when provider or account policy may substitute it.`;
    case 'openhuman':
      return '**Provider behavior (openhuman)**: wrapper roles compile to OpenHuman agent definitions; exact pins validate while semantic hints may be routed dynamically.';
    case 'warp':
    case 'hermes':
      return `**Provider behavior (${provider})**: delegation is available, but model selection is global/run-scoped. Use the wrapper rubric for task selection while reporting that heterogeneous per-worker pinning is not enforced.`;
    case 'windsurf':
      return '**Provider behavior (windsurf)**: portable subagent model selection is unsupported. Apply the decomposition rubric in the primary agent and do not claim wrapper pinning or parallel delegation.';
    default:
      return '**Provider behavior (unknown)**: delegation and per-worker model selection are unverified. Apply the rubric only where the active provider exposes those capabilities, and state any fallback explicitly.';
  }
}

/**
 * Build the parallelism-cap markdown section for injection into context files.
 * Returns `''` when injection should be skipped:
 *   - `AIWG_HIDE_PARALLELISM_IN_CONTEXT=1` is set
 *   - No `.aiwg/aiwg.config` exists at the project path
 */
export async function buildParallelismSection(projectPath: string, deps: ParallelismSectionDeps = {}): Promise<string> {
  if (process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT === '1') return '';

  let cfg: AiwgConfig | null;
  try {
    cfg = deps.readConfig
      ? await deps.readConfig(projectPath)
      : await readConfigWithBundledDefaults(projectPath);
  } catch (error) {
    if (!isBundledDefaultsFailure(error)) throw error;
    return [
      PARALLELISM_BLOCK_START,
      '## Parallelism Cap',
      '',
      PARALLELISM_HEALTH_UNRESOLVED_NOTE,
      '',
      PARALLELISM_BLOCK_END,
      '',
    ].join('\n');
  }
  if (!cfg) return '';

  const primary = cfg.providers[0];
  const resolved = resolveParallelism(cfg.parallelism, primary);
  const providerDefaults = primary && PROVIDER_PARALLELISM_DEFAULTS[primary];

  const isOverride = (field: keyof typeof resolved): boolean => {
    if (!providerDefaults) return false;
    if (field === 'rationale') return false;
    const def = providerDefaults[field as 'max_parallel_subagents' | 'max_parallel_ralph_loops' | 'max_parallel_mc_missions'];
    return resolved[field] !== def;
  };

  const label = (field: 'max_parallel_subagents' | 'max_parallel_ralph_loops' | 'max_parallel_mc_missions'): string => {
    const value = resolved[field];
    if (isOverride(field)) return `${value} (operator override)`;
    if (primary) return `${value} (provider default for ${primary})`;
    return `${value} (conservative default — unknown provider)`;
  };

  const lines: string[] = [];
  lines.push(PARALLELISM_BLOCK_START);
  lines.push('## Parallelism Cap');
  lines.push('');
  lines.push('This project caps parallel agent fan-out (#1359):');
  lines.push('');
  lines.push(`- **max_parallel_subagents**: ${label('max_parallel_subagents')}`);
  lines.push(`- **max_parallel_ralph_loops**: ${label('max_parallel_ralph_loops')}`);
  lines.push(`- **max_parallel_mc_missions**: ${label('max_parallel_mc_missions')}`);
  if (resolved.rationale) {
    lines.push('');
    lines.push(`*Rationale*: ${resolved.rationale}`);
  }
  lines.push('');
  lines.push('### Model-selected delegation rubric');
  lines.push('');
  lines.push('For each non-trivial task, assess whether it contains independent, bounded subtasks that can run concurrently. When delegation is supported, prefer the deployed model-pinned wrappers by task characteristics and consequence:');
  lines.push('');
  lines.push('- `aiwg-model-efficiency-worker`: discovery, inventory, focused edits, and other bounded low-cost work.');
  lines.push('- `aiwg-model-coding-worker`: implementation, tests, debugging, and routine technical delivery.');
  lines.push('- `aiwg-model-reasoning-worker`: architecture, synthesis, difficult analysis, and high-consequence review.');
  lines.push('');
  lines.push('Do not delegate trivial work, tightly coupled changes, serial dependencies, or tasks likely to collide in shared state; also keep work local when coordination costs exceed the expected benefit. Parallelize only independent work, and take the MIN of provider limits, `max_parallel_subagents`, `AIWG_CONTEXT_WINDOW` budget, framework-specific caps (including the RLM 7-agent hard cap for RLM dispatches), and natural task decomposition. Bump the project cap via `aiwg config set --project parallelism.max_parallel_subagents N`.');
  lines.push('');
  lines.push('The primary agent retains orchestration, final integration, conflict resolution, validation, and user-facing accountability.');
  lines.push('');
  lines.push(delegationSupport(primary));
  lines.push('');
  // Group dispatch disabled (worker_dispatch unset/false): the resolver reports
  // `disabled`, so no group block renders — the native-delegation rubric above
  // applies unchanged and the output stays byte-identical to the pre-dispatch
  // rendering.
  if (cfg.parallelism?.worker_dispatch === true) {
    const health = cfg.parallelism?.health;
    const check = healthValue(health, 'checkSeconds', 15);
    const startup = healthValue(health, 'startupSeconds', 60);
    const quiet = healthValue(health, 'quietSeconds', 90);
    const stall = healthValue(health, 'stallSeconds', 300);
    const hard = healthValue(health, 'hardTimeoutSeconds', 1800);
    lines.push('### Orchestration groups (group dispatch enabled)');
    lines.push('');
    const entries = Object.entries(cfg.parallelism?.groups ?? {});
    if (entries.length > 0) {
      // Slice before summarizing so at most MAX_SHOWN_GROUPS summaries are built.
      const shown = groupSummaries(entries.slice(0, MAX_SHOWN_GROUPS), cfg.parallelism).join(' | ');
      const hidden = entries.length - MAX_SHOWN_GROUPS;
      lines.push(`Configured groups: ${shown}${hidden > 0 ? ` (+${hidden} more)` : ''}`);
    } else {
      lines.push('Configured groups: none — group dispatch is enabled but no groups are configured; the native delegation rubric above applies unchanged.');
    }
    lines.push('');
    lines.push('Tier 0 direct handoff is the default: use your own shell or a qualified MCP worker tool. No Mission/MC session, scheduler, daemon, or activation marker is needed. Self-count active native + CLI + MCP workers, take the minimum of the project, group, CLI, model, and context caps, and launch each writing task once.');
    lines.push('');
    lines.push('Resolve each bounded brief with `aiwg models resolve --role <role> --task <class> --group <group> --brief <file> --workdir <tree> --final-output <file> --transport shell --format shell`. Copy the exact rendered command or the MCP server/tool/arguments byte-for-byte; never assemble vendor flags from memory. Re-resolve after any brief, profile, model, or workspace change. `--format shell` prints only the launch command: to see the resolved health windows for an attempt, use `--format json` (the default) and read `invocation.health` with its per-field `origins`.');
    lines.push('');
    lines.push(`Configured health windows (each followed by its origin — \`default\` or \`project config\`): check every ${check.value}s (${check.origin}); confirm startup within ${startup.value}s (${startup.origin}); quiet limit ${quiet.value}s (${quiet.origin}); stall limit ${stall.value}s (${stall.origin}); hard stop ${hard.value}s (${hard.origin}). Per-attempt windows scale quiet/stall by role, effort, and model (for example, reasoning at \`xhigh\` effort resolves 180s/600s from the 90s/300s defaults; a configured 1.25 scale gives 112.5s/375s) and cap every window by the remaining wall-clock and transport ceilings (\`resolveWorkerEffectiveHealth()\` in \`src/serve/worker-invocation.ts\`). Resolved values win over these configured values.`);
    lines.push('');
    lines.push('Supervise by observer state, never by suspicion. `quiet` (no observed activity for the quiet window, reported with confidence `suspected`) is not a stop: read the status (`aiwg ralph-external --status --workers --runs-root <dir> --json` is read-only and never kills or retries), check owned-worktree progress, and keep waiting — the observer’s `shouldStop()` stays false. `stalled` (no progress for the stall window) opens diagnosis through the diagnostic grace period; only `hung` (still no progress after grace, with the process live and connected) authorizes stopping — and only a worker this conductor owns. Confirm the stop (a sent signal, lease expiry, or final-file presence is not proof — only a confirmed exit is), preserve partial work for independent verification, then re-resolve within remaining attempts and budgets. Observer loss (`OBSERVER_GAP`, `DISCONNECTED`, degraded or unobserved coverage, opaque MCP output) is unknown, never worker failure: keep polling owned run files and processes from the shell at the same cadence. Heartbeats and log bytes are not progress. On correlated failure across workers sharing one account, quota, or host, pause further launches there and report cause and scope.');
    lines.push('');
  }
  lines.push(PARALLELISM_BLOCK_END);
  lines.push('');

  return lines.join('\n');
}

/**
 * Replace an existing parallelism-cap block inside `content` (between the
 * managed-block markers) with `newSection`. If no block exists yet, appends
 * the new section. If `newSection` is empty (cap is hidden), strips any
 * existing block in-place.
 *
 * Used by AIWG.md and AGENTS.md generators when reprocessing a file that
 * already has a parallelism block from a prior regeneration.
 */
export function replaceOrAppendParallelismBlock(content: string, newSection: string): string {
  const startIdx = content.indexOf(PARALLELISM_BLOCK_START);
  const endIdx = content.indexOf(PARALLELISM_BLOCK_END);

  if (startIdx >= 0 && endIdx > startIdx) {
    const before = content.slice(0, startIdx);
    const after = content.slice(endIdx + PARALLELISM_BLOCK_END.length);
    // Trim leading newline from `after` if present, since newSection ends with one
    const cleanAfter = after.startsWith('\n') ? after.slice(1) : after;
    return before + newSection + cleanAfter;
  }

  if (!newSection) return content;
  // No existing block — append before the final trailing newline
  return content.trimEnd() + '\n\n' + newSection;
}
