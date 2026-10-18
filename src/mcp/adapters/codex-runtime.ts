/**
 * Codex Per-Profile Runtime-Home Adapter
 *
 * Codex has no native per-session config flag (unlike `claude --mcp-config`).
 * This adapter implements the sysops `codex-role.sh` pattern:
 *
 *   1. Create <CODEX_HOME or ~/.codex>/roles-runtime/<profile>/ per profile
 *   2. Symlink shared state (history, sessions) into the runtime home
 *   3. Write a profile-scoped config.toml (stripped global MCP, only profile servers)
 *   4. Launch with CODEX_HOME=<runtime-home> codex
 *   5. Auth flows execute against the runtime home — OAuth tokens are isolated per profile
 *
 * Reference: roctinam/sysops:scripts/mcp-roles/codex-role.sh
 *
 * @implements #892
 */

import { signalChild } from '../../process/signal-child.mjs';
import { readFile, mkdir, symlink, access, readdir, chmod, lstat, open } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, constants } from 'fs';
import { spawn, spawnSync, type SpawnSyncReturns } from 'child_process';
import { boundedSpawnSync, resolveSyncProcessTimeoutMs } from '../../process/bounded-child-process.mjs';
import { isInteractive } from '../../cli/env.js';
import { exitCodeForSpawnResult } from '../../cli/child-process-result.js';
import { buildServerToml, type McpServerDefinition } from '../registry.js';
import { assertCredentialPolicy, resolveCredentialPolicy, type McpCredentialPolicy } from '../credentials.mjs';
import { planToolFilters, type ToolFilters } from '../tool-filters.mjs';
import { assertConfigDestination, writeConfigAtomic } from '../config-file.mjs';
import { stripMcpServers } from '../toml-strip-mcp.mjs';
import { resolveUserConfigDir } from '../../config/user-config-dir.mjs';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface RuntimeHomeInfo {
  profile: string;
  path: string;
  exists: boolean;
  hasConfig: boolean;
  hasOrphanedAuth: boolean;  // auth tokens present but profile may have been removed
}

export interface SharedStatePolicy {
  /** Files/dirs to symlink from the global codex home (shared across profiles) */
  shared: string[];
  /** Files/dirs that are profile-isolated (not symlinked) */
  isolated: string[];
}

const DEFAULT_SHARED_STATE: SharedStatePolicy = {
  // Shared: operator history and session index are cross-profile
  shared: ['history.jsonl', 'sessions'],
  // Isolated: auth tokens and per-profile config are scoped to the runtime home
  isolated: ['auth.json', '.credentials', 'config.toml'],
};

// ─────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

function runtimeHomesDir(): string {
  return join(codexHome(), 'roles-runtime');
}

function runtimeHomePath(profile: string): string {
  if (!/^[a-z0-9-]+$/.test(profile)) {
    throw new Error('Invalid profile name. Names must match [a-z0-9-]+.');
  }
  return join(runtimeHomesDir(), profile);
}

function runtimeConfigPath(profile: string): string {
  return join(runtimeHomePath(profile), 'config.toml');
}

// ─────────────────────────────────────────────
// Runtime home management
// ─────────────────────────────────────────────

async function ensurePrivateRuntimeHome(profile: string): Promise<string> {
  const rtHome = runtimeHomePath(profile);
  // The global .codex home may be managed by a dotfile symlink. Refuse
  // symlinks below it, including roles-runtime, the profile, and config.
  await assertConfigDestination(runtimeConfigPath(profile), codexHome());
  await mkdir(rtHome, { recursive: true, mode: 0o700 });
  await chmod(rtHome, 0o700);
  return rtHome;
}

/**
 * Ensure the runtime home directory exists for a profile.
 * Creates the directory and sets up shared-state symlinks.
 * Returns the runtime home path.
 */
export async function ensureRuntimeHome(
  profile: string,
  policy: SharedStatePolicy = DEFAULT_SHARED_STATE,
): Promise<string> {
  const rtHome = await ensurePrivateRuntimeHome(profile);

  const globalHome = codexHome();

  // Create symlinks for shared state (only if source exists in global home)
  for (const name of policy.shared) {
    const source = join(globalHome, name);
    const link = join(rtHome, name);

    // Skip if already linked or already exists
    try {
      await access(link);
      continue; // already exists
    } catch {
      // doesn't exist — create symlink if source exists
    }

    if (existsSync(source)) {
      try {
        await symlink(source, link);
      } catch {
        // ignore symlink errors (e.g., cross-device — not fatal)
      }
    }
  }

  return rtHome;
}

/**
 * Write a profile-scoped config.toml into the runtime home.
 * Strips the entire mcp_servers subtree from any existing global config.toml
 * and writes only the profile's servers.
 *
 * `options.floorPolicy`, when given, is an enforced organisation floor
 * (see `resolveCredentialPolicy`): this function resolves and enforces it
 * itself, so a direct caller that omits `credentialPolicy` or passes a
 * weaker value cannot write literal credentials below the floor. Pass
 * `floorPolicy` from the same registry whose servers are being written
 * (`McpServerRegistry#getCredentialPolicyFloor`); omitting it disables floor
 * enforcement for this call, matching a single registry with no layering.
 */
export async function writeProfileConfig(
  profile: string,
  servers: McpServerDefinition[],
  options: { credentialPolicy?: McpCredentialPolicy; floorPolicy?: McpCredentialPolicy; toolFilters?: ToolFilters } = {},
): Promise<string[]> {
  // env is deliberately excluded: the caller (CLI/session) already resolved
  // any environment/flag override before calling here, and `credentialPolicy`
  // carries that result as `flag`; this call only adds the floor enforcement.
  const resolvedPolicy = resolveCredentialPolicy({
    flag: options.credentialPolicy, floorPolicy: options.floorPolicy, env: {},
  });
  assertCredentialPolicy(servers, resolvedPolicy);
  const toolPlan = options.toolFilters
    ? planToolFilters('codex', servers.map((server) => server.name), options.toolFilters)
    : null;
  await ensurePrivateRuntimeHome(profile);

  // Load global config.toml as base (strip existing mcp_servers blocks)
  let baseConfig = '';
  const globalConfigPath = join(codexHome(), 'config.toml');
  try {
    const raw = await readFile(globalConfigPath, 'utf-8');
    baseConfig = stripMcpServers(raw).trimEnd();
  } catch (error) {
    // Only a missing global config permits an empty base. Classification and
    // read errors must never silently copy or replace a previous config.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  // Build profile-specific [mcp_servers.*] TOML sections
  const mcpSections = servers.map((server) =>
    [buildServerToml(server), ...(toolPlan?.tomlLines[server.name] ?? [])].join('\n'));

  const configContent =
    (baseConfig ? baseConfig + '\n\n' : '') +
    mcpSections.join('\n\n') +
    '\n';

  const configPath = runtimeConfigPath(profile);
  await writeConfigAtomic(configPath, configContent, { userScope: true, projectRoot: codexHome() });
  return toolPlan?.warnings ?? [];
}

/**
 * True iff `extraArgs` already selects one of codex's documented
 * non-interactive forms, so launching with them is safe to bound (#3062).
 * `exec` is the only evidenced one today (`codex exec <prompt>`; see
 * tools/ralph-external/lib/codex-adapter.mjs). Anything else — including no
 * args at all — hands the terminal to the interactive TUI.
 */
function isNonInteractiveCodexInvocation(extraArgs: string[]): boolean {
  return extraArgs[0] === 'exec';
}

/** Options for {@link launchWithProfile}. */
export interface LaunchWithProfileOptions {
  /**
   * Stdin payload for a non-interactive invocation (e.g. a prompt, fed to
   * `codex exec -`). Never placed on argv (#3062 review item 8).
   */
  input?: string;
  /**
   * Explicit interactive/non-interactive decision, overriding this
   * function's own `isInteractive()` call (#3062 review item 12) — the one
   * shared interactive decision a caller (e.g. `aiwg session
   * --non-interactive`) may have already computed from its own flags.
   * Defaults to `isInteractive()` when omitted, preserving prior behavior
   * for callers that do not thread an explicit decision through.
   */
  interactive?: boolean;
}

/**
 * Launch Codex with a profile's runtime home.
 * Sets CODEX_HOME and HOME to the runtime home so Codex reads its profile-scoped config and
 * OAuth tokens are written to the runtime home (isolated from other profiles).
 *
 * Headless (#3062): when `extraArgs` is already a non-interactive form (see
 * {@link isNonInteractiveCodexInvocation}), the call never hands over the
 * terminal, so it is bounded like any other child process and never inherits
 * stdin — unless `options.input` is given, in which case it carries the
 * prompt on stdin instead (review item 8). Otherwise this launches the
 * interactive TUI, which requires a terminal — without one, this refuses
 * instead of spawning something that would hang.
 */
export function launchWithProfile(
  profile: string,
  extraArgs: string[] = [],
  options: LaunchWithProfileOptions = {},
): SpawnSyncReturns<Buffer> {
  const rtHome = runtimeHomePath(profile);

  if (!existsSync(rtHome)) {
    throw new Error(
      `Runtime home for profile "${profile}" does not exist.\n` +
      `Run "aiwg mcp profile add ${profile}" or "aiwg session --provider codex --profile ${profile}" to create it.`,
    );
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: rtHome,
    CODEX_HOME: rtHome,
    // Resolve before HOME changes so the child retains the operator's
    // installation identity, channel and other provider-neutral configuration.
    AIWG_CONFIG: resolveUserConfigDir(),
  };

  if (isNonInteractiveCodexInvocation(extraArgs)) {
    // Bounded (#3062): `codex exec -` never hands over the terminal; the
    // prompt (if any) rides on stdin via `options.input`, never on argv.
    return boundedSpawnSync('codex', extraArgs, 'long', {
      stdio: options.input !== undefined ? ['pipe', 'inherit', 'inherit'] : ['ignore', 'inherit', 'inherit'],
      env,
      ...(options.input !== undefined ? { input: options.input } : {}),
    }) as SpawnSyncReturns<Buffer>;
  }

  if (!(options.interactive ?? isInteractive())) {
    throw new Error(
      `Launching codex for profile "${profile}" with no arguments hands over the terminal and requires one to be attached.\n` +
      'Pass a non-interactive form instead — e.g. run `aiwg session --provider codex --profile ' +
      `${profile} --prompt "<text>"\` (maps to \`codex exec -\`, with the prompt on stdin).`,
    );
  }

  // sync-spawn: interactive codex-exec — replaces the terminal with the codex
  // binary the user is meant to talk to, when extraArgs is not already a
  // non-interactive form (see tools/testing/sync-spawn-allowlist.json).
  // Reached only when `options.interactive ?? isInteractive()` is true
  // (#3062) — the non-interactive and no-terminal paths above are handled
  // before this point. Not a candidate for a bounded timeout.
  return spawnSync('codex', extraArgs, {
    stdio: 'inherit',
    env,
  });
}

/**
 * Build a child environment that excludes `envVarName` (when given) and
 * any other variable holding the identical value (#3062 second review,
 * finding 1): the API key must never be visible in the child's own
 * environment, only on its stdin, including as a coincidental duplicate
 * under some other name. `envVarName` is `undefined` when the key came
 * from somewhere other than a named environment variable (`--api-key-stdin`
 * / `--api-key-file`, go/no-go review blocker 1C) — the by-value scrub
 * still applies in that case.
 */
function envWithoutSecretValue(
  base: NodeJS.ProcessEnv,
  envVarName: string | undefined,
  secretValue: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (envVarName !== undefined && key === envVarName) continue;
    if (value === secretValue) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Read an API key from a private file (#3062 go/no-go review, blocker 1C):
 * `--api-key-file <path>` reads the key from disk instead of an
 * environment variable, so a file that does not meet the same bar the
 * decision ledger's own file writer enforces
 * (`src/decision/ledger.ts`'s `openLedgerFileForAppend`) is refused rather
 * than silently trusted. This mirrors that check for a read instead of a
 * write — there is no already-exported helper at this layer to reuse (the
 * ledger's checks are private to that module and tied to its own
 * create-if-missing write path), so this re-implements the same checks for
 * a read: never follow a symlink; the open file descriptor must resolve to
 * a regular file with exactly one hard link; and, on POSIX, must be owned
 * by the current user with no group/other permission bits. The file's
 * contents are returned trimmed; no error message here ever includes them.
 */
async function readApiKeyFromFile(filePath: string): Promise<string> {
  try {
    const pre = await lstat(filePath);
    if (pre.isSymbolicLink()) {
      throw new Error(`--api-key-file: "${filePath}" is a symlink; refusing to follow it.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`--api-key-file: "${filePath}" does not exist.`);
    }
    if (error instanceof Error && error.message.startsWith('--api-key-file:')) throw error;
    throw new Error(`--api-key-file: cannot stat "${filePath}": ${(error as Error).message}`);
  }

  const hasNoFollow = typeof constants.O_NOFOLLOW === 'number';
  const flags = constants.O_RDONLY | (hasNoFollow ? constants.O_NOFOLLOW : 0);
  let handle;
  try {
    handle = await open(filePath, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new Error(`--api-key-file: "${filePath}" is a symlink; refusing to follow it.`);
    if (code === 'ENOENT') throw new Error(`--api-key-file: "${filePath}" does not exist.`);
    throw new Error(`--api-key-file: cannot open "${filePath}": ${(error as Error).message}`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`--api-key-file: "${filePath}" is not a regular file.`);
    }
    if (stat.nlink !== 1) {
      throw new Error(`--api-key-file: "${filePath}" has more than one hard link; refusing to read it.`);
    }
    if (process.platform !== 'win32') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (uid !== null && stat.uid !== uid) {
        throw new Error(`--api-key-file: "${filePath}" is not owned by the current user.`);
      }
      if ((stat.mode & 0o077) !== 0) {
        throw new Error(
          `--api-key-file: "${filePath}" must not be readable or writable by group or other ` +
          '(chmod 600 it).',
        );
      }
    }
    return (await handle.readFile({ encoding: 'utf-8' })).trim();
  } finally {
    await handle.close();
  }
}

/**
 * Async, credential-safe launch of `codex login --with-api-key` (#3062
 * second review, finding 1). This is an *interactive-site exception* to
 * the synchronous bounded-child-process helper — not a sync call at all,
 * so the sync-child-process gate does not (and should not) apply to it.
 *
 * `boundedSpawnSync`'s `input` option places the secret inside the
 * options object `child_process` hands to its native binding, which
 * `NODE_DEBUG=child_process` (and any other dump of those options)
 * prints verbatim — confirmed by the review with a live probe. An async
 * `spawn()` has no `input` option at all: the key is written directly to
 * the already-created child's own `stdin` stream, after the options
 * object was already built and handed off, so it is never part of any
 * options object, logged value, or thrown Error. The 'network'-tier bound
 * (same as the previous synchronous call) is enforced here by hand, with
 * the same SIGKILL-and-enriched-message contract the bounded helper
 * itself uses, since this call can no longer go through that helper.
 */
function spawnCodexLoginWithApiKey(
  apiKey: string,
  env: Record<string, string>,
): Promise<{ status: number | null; signal: NodeJS.Signals | null; error?: Error }> {
  const tier = 'network' as const;
  const boundMs = resolveSyncProcessTimeoutMs(tier);
  return new Promise((resolve) => {
    const child = spawn('codex', ['login', '--with-api-key'], {
      env,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // #3062 go/no-go review, blocker 2: stdin error, write completion,
    // child 'error', child 'exit', and the deadline all funnel through this
    // one function, which settles exactly once, always clears the timer and
    // removes every listener this call added, and kills the child if it is
    // still alive on a failing settlement (a running process on the
    // timeout path; a process that may still be running on an unexpected
    // stdin-write error). The 'exit' path never reaches the kill — by the
    // time that event fires the child has already exited.
    const settle = (result: { status: number | null; signal: NodeJS.Signals | null; error?: Error }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.stdin?.removeListener('error', onStdinError);
      child.removeListener('error', onChildError);
      child.removeListener('exit', onExit);
      if (result.error && child.exitCode === null && child.signalCode === null) {
        try { signalChild(child, 'SIGKILL'); } catch { /* already gone */ }
      }
      resolve(result);
    };

    timer = setTimeout(() => {
      settle({
        status: null,
        signal: 'SIGKILL',
        error: Object.assign(
          new Error(`\`codex login --with-api-key\` exceeded the '${tier}' tier bound of ${boundMs}ms and was killed (SIGKILL).`),
          { code: 'ETIMEDOUT' },
        ),
      });
    }, boundMs);

    const onChildError = (err: Error) => settle({ status: null, signal: null, error: err });
    child.on('error', onChildError);

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => settle({ status: code, signal });
    child.on('exit', onExit);

    // A child that exits (or closes its read end) before reading stdin
    // raises EPIPE/ECONNRESET on the *stdin stream*, not on the child
    // object — `child.on('error', ...)` above never sees it, so without
    // this listener it is an unhandled 'error' event, which Node turns into
    // an uncaught exception. Installed before the write/end below, per the
    // review. EPIPE/ECONNRESET specifically mean "the child already went
    // away"; the already-firing (or about-to-fire) 'exit' event carries the
    // real, non-secret result, so this swallows exactly those two codes and
    // lets settle() happen there instead. Anything else is a genuine,
    // unexpected stdin failure and is itself the settling error.
    const onStdinError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' || err.code === 'ECONNRESET') return;
      settle({ status: null, signal: null, error: err });
    };
    child.stdin!.on('error', onStdinError);

    // Written directly to the live stream — never part of the spawn
    // options object above, so NODE_DEBUG=child_process (and any dump of
    // those options) cannot print it. `end(chunk, callback)` reports a
    // failed write through its callback; `onStdinError` above is the
    // primary path (Node always emits 'error' on the stream too), so this
    // callback only needs to catch the case where, for some Node version or
    // stream state, the callback fires but the 'error' event does not.
    child.stdin!.end(apiKey, (err?: Error | null) => {
      const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
      if (err && code !== 'EPIPE' && code !== 'ECONNRESET') {
        settle({ status: null, signal: null, error: err });
      }
    });
  });
}

/**
 * Run `codex login` within a profile's runtime home to isolate OAuth tokens.
 *
 * Headless (#3062): pass `apiKeyEnv` to log in non-interactively. codex-cli
 * documents `--with-api-key` for exactly this (verified: `codex login
 * --help`, codex-cli 0.162.1 — "Read the API key from stdin (e.g. `printenv
 * OPENAI_API_KEY | codex login --with-api-key`)"); this function reads
 * `process.env[apiKeyEnv]` and feeds it to codex over stdin, so the key
 * itself never appears on argv or in a process listing — only the
 * environment-variable *name* is ever passed around. Without `apiKeyEnv`
 * and without a terminal, this refuses instead of spawning the interactive
 * OAuth flow, which would hang waiting for input nobody can supply.
 *
 * Wired to `aiwg mcp profile login <name> [--api-key-env <NAME>]`
 * (`src/mcp/cli.mjs`, #3069). The `apiKeyEnv` branch never places the key
 * in a spawn options object or the child's own environment — see
 * `spawnCodexLoginWithApiKey()`'s doc comment.
 */
export async function loginInProfile(
  profile: string,
  options: { apiKeyEnv?: string; apiKey?: string } = {},
): Promise<void> {
  await ensureRuntimeHome(profile);
  const rtHome = runtimeHomePath(profile);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: rtHome,
    CODEX_HOME: rtHome,
    AIWG_CONFIG: resolveUserConfigDir(),
  };

  // `options.apiKey` (go/no-go review, blocker 1C) is the already-resolved
  // key from `--api-key-stdin`/`--api-key-file` — the caller (`src/mcp/
  // cli.mjs`) read and validated it before calling here, so there is no
  // single named source environment variable to exclude below, only the
  // by-value scrub `envWithoutSecretValue()` always does. `options.apiKeyEnv`
  // is unchanged: still read from `process.env` here, so its *name* is the
  // one thing ever passed around. Exactly one of the two is ever set — the
  // CLI layer enforces that mutual exclusivity before calling this function.
  let apiKey: string | undefined;
  let sourceDescription: string | undefined;
  if (options.apiKey !== undefined) {
    apiKey = options.apiKey;
    sourceDescription = 'the supplied key';
  } else if (options.apiKeyEnv) {
    apiKey = process.env[options.apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `Environment variable "${options.apiKeyEnv}" is not set; cannot log in to profile "${profile}" non-interactively.`,
      );
    }
    sourceDescription = `an API key from $${options.apiKeyEnv}`;
  }

  if (apiKey !== undefined) {
    console.log(`\n  Logging in to profile "${profile}" with ${sourceDescription}...`);
    // Credential-safe async launch (#3062 second review, finding 1): the
    // key never enters a spawn options object, env dump, log line, or
    // thrown value — see spawnCodexLoginWithApiKey()'s own doc comment for
    // why this can no longer be the synchronous bounded helper.
    const safeEnv = envWithoutSecretValue(env, options.apiKeyEnv, apiKey);
    const result = await spawnCodexLoginWithApiKey(apiKey, safeEnv);
    if (result.status !== 0) {
      // #3062 review item 7: surface the bounded helper's `error`/`signal`
      // detail (e.g. the enriched timeout message naming the bound and
      // override variable) instead of only the exit code.
      const { message } = exitCodeForSpawnResult(result, 'codex login --with-api-key');
      throw new Error(message ?? `codex login --with-api-key failed with exit code ${result.status ?? 'unknown'}`);
    }
    return;
  }

  if (!isInteractive()) {
    throw new Error(
      `Logging in to profile "${profile}" requires an interactive terminal, or a key supplied via ` +
      '--api-key-env, --api-key-stdin, or --api-key-file (never pass the key itself on the command ' +
      `line), or run \`codex login\` yourself with CODEX_HOME=${rtHome}.`,
    );
  }

  console.log(`\n  Running codex login in profile "${profile}" runtime home...`);
  console.log(`  Auth tokens will be isolated to: ${rtHome}\n`);

  // sync-spawn: interactive codex-login — runs the codex OAuth login flow,
  // which prompts the user directly (see tools/testing/
  // sync-spawn-allowlist.json). Reached only when isInteractive() is true
  // and no apiKeyEnv was given (#3062). Not a candidate for a bounded
  // timeout.
  const result = spawnSync('codex', ['login'], {
    stdio: 'inherit',
    env,
  });

  if (result.status !== 0) {
    const { message } = exitCodeForSpawnResult(result, 'codex login');
    throw new Error(message ?? `codex login failed with exit code ${result.status ?? 'unknown'}`);
  }
}

// ─────────────────────────────────────────────
// Introspection
// ─────────────────────────────────────────────

/**
 * List all runtime homes (one per profile that has been set up).
 */
export async function listRuntimeHomes(): Promise<RuntimeHomeInfo[]> {
  const dir = runtimeHomesDir();

  if (!existsSync(dir)) return [];

  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  return Promise.all(
    entries.map(async (name) => {
      const rtPath = join(dir, name);
      const configPath = join(rtPath, 'config.toml');
      const authPath = join(rtPath, 'auth.json');

      return {
        profile: name,
        path: rtPath,
        exists: true,
        hasConfig: existsSync(configPath),
        hasOrphanedAuth: existsSync(authPath),
      };
    }),
  );
}

/**
 * Remove a profile's runtime home (destructive — deletes auth tokens).
 * Returns false if the home does not exist.
 */
export async function removeRuntimeHome(profile: string): Promise<boolean> {
  const rtHome = runtimeHomePath(profile);
  if (!existsSync(rtHome)) return false;

  // Local filesystem delete; bounded as a quick-tier call (#3062).
  const result = boundedSpawnSync('rm', ['-rf', rtHome], 'quick', { stdio: 'inherit' });
  return result.status === 0;
}

/**
 * Detect orphaned runtime homes: runtime homes where the corresponding
 * MCP profile no longer exists in the profile registry.
 */
export async function detectOrphanedRuntimes(
  knownProfiles: string[],
): Promise<RuntimeHomeInfo[]> {
  const homes = await listRuntimeHomes();
  return homes.filter((h) => !knownProfiles.includes(h.profile));
}

// ─────────────────────────────────────────────
// Re-exports (convenience)
// ─────────────────────────────────────────────

export { DEFAULT_SHARED_STATE, readApiKeyFromFile };
