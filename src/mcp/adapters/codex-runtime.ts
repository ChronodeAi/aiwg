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

import { readFile, mkdir, symlink, access, readdir, chmod } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { boundedSpawnSync } from '../../process/bounded-child-process.mjs';
import { isInteractive } from '../../cli/env.js';
import { buildServerToml, type McpServerDefinition } from '../registry.js';
import { assertCredentialPolicy, resolveCredentialPolicy, type McpCredentialPolicy } from '../credentials.mjs';
import { planToolFilters, type ToolFilters } from '../tool-filters.mjs';
import { assertConfigDestination, writeConfigAtomic } from '../config-file.mjs';
import { stripMcpServers } from '../toml-strip-mcp.mjs';

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

/**
 * Launch Codex with a profile's runtime home.
 * Sets CODEX_HOME and HOME to the runtime home so Codex reads its profile-scoped config and
 * OAuth tokens are written to the runtime home (isolated from other profiles).
 *
 * Headless (#3062): when `extraArgs` is already a non-interactive form (see
 * {@link isNonInteractiveCodexInvocation}), the call never hands over the
 * terminal, so it is bounded like any other child process and never inherits
 * stdin. Otherwise this launches the interactive TUI, which requires a
 * terminal — without one, this refuses instead of spawning something that
 * would hang.
 */
export function launchWithProfile(
  profile: string,
  extraArgs: string[] = [],
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
  };

  if (isNonInteractiveCodexInvocation(extraArgs)) {
    // Bounded (#3062): `codex exec <prompt>` never hands over the terminal.
    return boundedSpawnSync('codex', extraArgs, 'long', {
      stdio: ['ignore', 'inherit', 'inherit'],
      env,
    }) as SpawnSyncReturns<Buffer>;
  }

  if (!isInteractive()) {
    throw new Error(
      `Launching codex for profile "${profile}" with no arguments hands over the terminal and requires one to be attached.\n` +
      'Pass a non-interactive form instead — e.g. run `aiwg session --provider codex --profile ' +
      `${profile} --prompt "<text>"\` (maps to \`codex exec <text>\`).`,
    );
  }

  // sync-spawn: interactive codex-exec — replaces the terminal with the codex
  // binary the user is meant to talk to, when extraArgs is not already a
  // non-interactive form (see tools/testing/sync-spawn-allowlist.json).
  // Reached only when isInteractive() is true (#3062) — the non-interactive
  // and no-terminal paths above are handled before this point. Not a
  // candidate for a bounded timeout.
  return spawnSync('codex', extraArgs, {
    stdio: 'inherit',
    env,
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
 * NOTE: there is currently no CLI command wired to this parameter — see the
 * `codex-login` entry in tools/testing/sync-spawn-allowlist.json and the
 * #3062 slice report for the open question (`aiwg mcp profile login` is
 * documented but not implemented; wiring it is a separate decision).
 */
export async function loginInProfile(
  profile: string,
  options: { apiKeyEnv?: string } = {},
): Promise<void> {
  await ensureRuntimeHome(profile);
  const rtHome = runtimeHomePath(profile);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: rtHome,
    CODEX_HOME: rtHome,
  };

  if (options.apiKeyEnv) {
    const apiKey = process.env[options.apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `Environment variable "${options.apiKeyEnv}" is not set; cannot log in to profile "${profile}" non-interactively.`,
      );
    }
    console.log(`\n  Logging in to profile "${profile}" with an API key from $${options.apiKeyEnv}...`);
    // Bounded (#3062): `--with-api-key` reads the key from stdin and exits —
    // it never hands over the terminal — so this is safe to bound like any
    // other child process. `input` carries the key on stdin only; it is
    // never placed on argv.
    const result = boundedSpawnSync('codex', ['login', '--with-api-key'], 'network', {
      input: apiKey,
      env,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    if (result.status !== 0) {
      throw new Error(`codex login --with-api-key failed with exit code ${result.status ?? 'unknown'}`);
    }
    return;
  }

  if (!isInteractive()) {
    throw new Error(
      `Logging in to profile "${profile}" requires an interactive terminal, or an API key.\n` +
      'Pass { apiKeyEnv: "<ENV_VAR_NAME>" } to read the key from that environment variable ' +
      '(never pass the key itself on the command line), or run `codex login` yourself with ' +
      `CODEX_HOME=${rtHome}.`,
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
    throw new Error(`codex login failed with exit code ${result.status ?? 'unknown'}`);
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

export { DEFAULT_SHARED_STATE };
