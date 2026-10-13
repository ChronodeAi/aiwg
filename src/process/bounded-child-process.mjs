/**
 * Bounded synchronous child-process wrappers (#3062).
 *
 * `execSync`/`execFileSync`/`spawnSync` block the calling thread for as long
 * as the child — or any grandchild still holding an inherited pipe — lives.
 * With no timeout that is unbounded: it hung the test suite once and can
 * hang the CLI when it runs without a terminal. These wrappers make every
 * call bounded by construction: a required `tier` selects the wall-clock
 * cap, the call never inherits stdin, and a timeout always surfaces as the
 * normal Node `ETIMEDOUT` error/result with a message that names the
 * command, tier and bound.
 *
 * Tiers (see `SYNC_PROCESS_TIER_BOUNDS_MS`):
 *   - `quick`   30s  — local queries: git status/rev-parse/config, version
 *                      probes, `which`/`where`, `df`, tmux queries.
 *   - `network` 2m   — git fetch/pull/ls-remote/push, `gh`/API calls.
 *   - `long`    10m  — installs, clones, docker, builds, test runs launched
 *                      by scripts. Overridable via `AIWG_SYNC_LONG_TIMEOUT_MS`
 *                      (see `resolveSyncProcessTimeoutMs`); `quick`/`network`
 *                      are not overridable.
 *
 * Choose the tier by what the command does, not by where the call site
 * lives.
 *
 * Interactive-by-design calls (an editor, a login flow, launching a harness
 * binary the user is meant to talk to) do not belong here — bounding them
 * would just make the interactive session time out. Leave those sites on
 * the plain Node APIs.
 *
 * ## Why timeout kills with SIGKILL, not SIGTERM-then-SIGKILL
 *
 * Node's own `timeout`/`killSignal` option sends `killSignal` exactly once
 * when the bound elapses, then keeps blocking until the child actually
 * exits. If the child ignores that signal — trivial to do for SIGTERM, and
 * exactly the "grandchild holding an inherited pipe" scenario this gate
 * exists to catch — the call hangs forever regardless of the configured
 * timeout; killSignal only picks *which* signal is sent once, not whether
 * the wait ever ends. There is no portable way to schedule a second signal
 * from inside a single blocking native call: the calling thread is blocked
 * in a C++ synchronous spawn, so no JS timer can run to escalate.
 *
 * These wrappers therefore use `killSignal: 'SIGKILL'` directly. SIGKILL
 * cannot be caught, blocked or ignored, so the bound is a hard guarantee —
 * confirmed with a real child that traps and ignores SIGTERM (see
 * `test/unit/process/bounded-child-process.test.mjs`): with `killSignal:
 * 'SIGTERM'` the call hangs indefinitely; with `'SIGKILL'` it returns at the
 * bound, every time. Callers that want a specific signal may still pass
 * `killSignal` explicitly; it is honored as-is.
 *
 * @module src/process/bounded-child-process
 */

import {
  execSync as nodeExecSync,
  execFileSync as nodeExecFileSync,
  spawnSync as nodeSpawnSync,
} from 'node:child_process';

/** Env var that raises or disables the `long` tier bound. `0` disables it (no timeout). */
export const AIWG_SYNC_LONG_TIMEOUT_MS_ENV = 'AIWG_SYNC_LONG_TIMEOUT_MS';

/**
 * Default wall-clock bounds per tier, in milliseconds. `quick` and `network`
 * are fixed; `long` is the default absent `AIWG_SYNC_LONG_TIMEOUT_MS`.
 */
export const SYNC_PROCESS_TIER_BOUNDS_MS = Object.freeze({
  quick: 30_000,
  network: 120_000,
  long: 600_000,
});

const VALID_TIERS = new Set(Object.keys(SYNC_PROCESS_TIER_BOUNDS_MS));

let warnedInvalidLongTimeoutEnv = false;

/**
 * Resolve the `long` tier bound, honoring `AIWG_SYNC_LONG_TIMEOUT_MS`.
 *
 * - Unset/empty → the default (`SYNC_PROCESS_TIER_BOUNDS_MS.long`).
 * - `"0"` → disabled: no bound is applied to the `long` tier at all.
 * - A positive integer → that many milliseconds.
 * - Anything else → the default, with one warning to stderr per process.
 *
 * @returns {number} Milliseconds, or `0` meaning "no bound".
 */
function resolveLongTierTimeoutMs() {
  const raw = process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV];
  if (raw === undefined || raw.trim() === '') return SYNC_PROCESS_TIER_BOUNDS_MS.long;
  const trimmed = raw.trim();
  if (trimmed === '0') return 0;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    if (!warnedInvalidLongTimeoutEnv) {
      warnedInvalidLongTimeoutEnv = true;
      console.warn(
        `[aiwg] ${AIWG_SYNC_LONG_TIMEOUT_MS_ENV}=${JSON.stringify(raw)} is not a positive integer or "0"; ` +
        `using the default long-tier bound (${SYNC_PROCESS_TIER_BOUNDS_MS.long}ms).`,
      );
    }
    return SYNC_PROCESS_TIER_BOUNDS_MS.long;
  }
  return parsed;
}

/**
 * Exposed for tests and for the gate/report tooling: resolve the effective
 * bound for a tier right now (reads the env override for `long` each call,
 * same as the wrappers do).
 *
 * @param {'quick'|'network'|'long'} tier
 * @returns {number} Milliseconds; `0` means "no bound" (long tier disabled).
 */
export function resolveSyncProcessTimeoutMs(tier) {
  assertValidTier(tier);
  if (tier === 'long') return resolveLongTierTimeoutMs();
  return SYNC_PROCESS_TIER_BOUNDS_MS[tier];
}

function assertValidTier(tier) {
  if (!VALID_TIERS.has(tier)) {
    throw new TypeError(
      `Sync process tier must be one of ${[...VALID_TIERS].map((t) => `'${t}'`).join(', ')}; got ${JSON.stringify(tier)}.`,
    );
  }
}

/**
 * The bound actually applied to one call: the tier bound, unless the
 * caller's own `options.timeout` is a smaller positive number (an explicit
 * smaller timeout always wins; a zero/negative/non-numeric one is ignored —
 * a call site cannot silently opt out of the tier bound by passing
 * `timeout: 0` itself; only the `long`-tier env var can disable a bound).
 *
 * @param {'quick'|'network'|'long'} tier
 * @param {{timeout?: number}} [options]
 * @returns {number}
 */
function effectiveTimeoutMs(tier, options) {
  const bound = resolveSyncProcessTimeoutMs(tier);
  const explicit = options?.timeout;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0 && (bound === 0 || explicit < bound)) {
    return explicit;
  }
  return bound;
}

/**
 * A bounded call never inherits stdin; stdout/stderr may still be inherited
 * for progress output. Leaves `options` untouched when the caller supplies
 * `input` (Node feeds stdin from that value regardless of `stdio`, and
 * forcing it to `'ignore'` would break that) or when stdin was not going to
 * be inherited anyway.
 *
 * @param {Record<string, unknown>} options
 * @returns {Record<string, unknown>}
 */
function withoutInheritedStdin(options) {
  if (options.input !== undefined) return options;
  if (options.stdio === 'inherit') {
    return { ...options, stdio: ['ignore', 'inherit', 'inherit'] };
  }
  if (Array.isArray(options.stdio) && options.stdio[0] === 'inherit') {
    const stdio = options.stdio.slice();
    stdio[0] = 'ignore';
    return { ...options, stdio };
  }
  return options;
}

/**
 * Build the final Node options: bounded stdin, resolved timeout, and a
 * SIGKILL default kill signal (callers may still pass their own
 * `killSignal`, which is honored as-is).
 *
 * @param {Record<string, unknown> | undefined} options
 * @param {number} boundMs
 * @returns {Record<string, unknown>}
 */
function toNodeOptions(options, boundMs) {
  const base = withoutInheritedStdin(options ?? {});
  return {
    ...base,
    timeout: boundMs,
    killSignal: base.killSignal ?? 'SIGKILL',
  };
}

function describeCommand(command, args) {
  if (args === undefined) return command;
  return [command, ...args].join(' ');
}

/**
 * On timeout (`error.code === 'ETIMEDOUT'`), prepend a message naming the
 * command, tier and bound. Leaves every other field (`code`, `signal`,
 * `status`, `killed`) exactly as Node set them, and leaves non-timeout
 * errors untouched, so existing catch blocks that inspect those fields (or
 * just catch-and-ignore) keep working.
 *
 * @template {Error & {code?: string}} E
 * @param {E | null | undefined} error
 * @param {{description: string, tier: string, boundMs: number}} context
 * @returns {E | null | undefined}
 */
function enrichTimeoutError(error, { description, tier, boundMs }) {
  if (!error || error.code !== 'ETIMEDOUT') return error;
  error.message =
    `\`${description}\` exceeded the '${tier}' tier bound of ${boundMs}ms and was killed (SIGKILL). ` +
    (tier === 'long' ? `Set ${AIWG_SYNC_LONG_TIMEOUT_MS_ENV} to a larger number of milliseconds, or 0 to remove the bound. ` : '') +
    error.message;
  return error;
}

/**
 * Bounded `child_process.execSync`. Same arguments and return value as
 * Node's `execSync(command, options)`, with a required `tier` inserted
 * before `options`.
 *
 * @param {string} command
 * @param {'quick'|'network'|'long'} tier
 * @param {Record<string, unknown>} [options]
 * @returns {Buffer | string}
 */
export function boundedExecSync(command, tier, options) {
  assertValidTier(tier);
  const boundMs = effectiveTimeoutMs(tier, options);
  const nodeOptions = toNodeOptions(options, boundMs);
  try {
    return nodeExecSync(command, nodeOptions);
  } catch (error) {
    throw enrichTimeoutError(error, { description: command, tier, boundMs });
  }
}

/**
 * Bounded `child_process.execFileSync`. Same arguments and return value as
 * Node's `execFileSync(file, args, options)`, with a required `tier`
 * inserted before `options`. Unlike the native API, `args` is always
 * required (pass `[]` for none) so tier can occupy a fixed position.
 *
 * @param {string} file
 * @param {readonly string[]} args
 * @param {'quick'|'network'|'long'} tier
 * @param {Record<string, unknown>} [options]
 * @returns {Buffer | string}
 */
export function boundedExecFileSync(file, args, tier, options) {
  assertValidTier(tier);
  const boundMs = effectiveTimeoutMs(tier, options);
  const nodeOptions = toNodeOptions(options, boundMs);
  try {
    return nodeExecFileSync(file, args, nodeOptions);
  } catch (error) {
    throw enrichTimeoutError(error, { description: describeCommand(file, args), tier, boundMs });
  }
}

/**
 * Bounded `child_process.spawnSync`. Same arguments and return shape as
 * Node's `spawnSync(command, args, options)`, with a required `tier`
 * inserted before `options`. Unlike the native API, `args` is always
 * required (pass `[]` for none) so tier can occupy a fixed position.
 *
 * `spawnSync` never throws; on timeout the returned object has
 * `status: null`, `signal: 'SIGKILL'` and an `error` with
 * `code: 'ETIMEDOUT'` whose message has been enriched in place.
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @param {'quick'|'network'|'long'} tier
 * @param {Record<string, unknown>} [options]
 * @returns {import('node:child_process').SpawnSyncReturns<Buffer | string>}
 */
export function boundedSpawnSync(command, args, tier, options) {
  assertValidTier(tier);
  const boundMs = effectiveTimeoutMs(tier, options);
  const nodeOptions = toNodeOptions(options, boundMs);
  const result = nodeSpawnSync(command, args, nodeOptions);
  enrichTimeoutError(result.error, { description: describeCommand(command, args), tier, boundMs });
  return result;
}
