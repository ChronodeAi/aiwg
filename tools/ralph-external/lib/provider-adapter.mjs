/**
 * Provider Adapter Base Class for External Ralph Loop
 *
 * Defines the interface that all CLI provider adapters must implement.
 * Each adapter wraps a specific agentic coding CLI (claude, codex, etc.)
 * and handles binary resolution, argument construction, model mapping,
 * and output parsing.
 *
 * @implements Plan: Multi-Provider Support for External Ralph Loop
 */

import { spawn } from 'child_process';
import { importImpl } from '../../_resolve-impl.mjs';

const installedOwner = await importImpl(import.meta.url, 'models/worker-installation.mjs');
export const { workerNegativeFixtureSuite, workerNegativeFixtureDigest, registerProvider, createProvider, listProviders, hasProvider } = installedOwner;

/**
 * Whether the optional muse exec Ralph adapter is registered.
 * Enabled by default; set `AIWG_MUSE_RALPH_ENABLED` to `0`, `false`, `no`,
 * or `off` to disable the adapter without affecting
 * `aiwg use --provider muse` (the deploy/writer path lives in `src/` and
 * never consults this registry). See
 * `tools/ralph-external/lib/muse-adapter.mjs` (#230).
 *
 * @returns {boolean}
 */
export function isMuseRalphEnabled() {
  const raw = String(process.env.AIWG_MUSE_RALPH_ENABLED ?? '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

/**
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} streamJson - Supports --output-format stream-json
 * @property {boolean} sessionResume - Supports --session-id for resumption
 * @property {boolean} budgetControl - Supports --max-budget-usd
 * @property {boolean} systemPrompt - Supports --append-system-prompt
 * @property {boolean} agentMode - Supports --agent flag
 * @property {boolean} mcpConfig - Supports --mcp-config
 * @property {boolean} maxTurns - Supports --max-turns
 */

/**
 * @typedef {Object} SessionArgs
 * @property {string} prompt - The prompt to send
 * @property {string} [sessionId] - Session UUID for tracking
 * @property {string} [model] - Model name (generic: opus/sonnet/haiku)
 * @property {number} [budget] - Budget per iteration in USD
 * @property {number} [maxTurns] - Maximum turns
 * @property {boolean} [verbose] - Enable verbose output
 * @property {string} [systemPrompt] - System prompt to append
 * @property {Object} [mcpConfig] - MCP server configuration
 */

/**
 * @typedef {Object} AnalysisArgs
 * @property {string} prompt - The analysis prompt
 * @property {string} [model] - Model name (generic: opus/sonnet/haiku)
 * @property {string} [agent] - Agent name to use
 * @property {number} [timeout] - Timeout in ms
 */

/**
 * Base class for provider adapters.
 * Subclasses must override all methods that throw NotImplementedError.
 */
export class ProviderAdapter {
  constructor() {
    if (new.target === ProviderAdapter) {
      throw new Error('ProviderAdapter is abstract and cannot be instantiated directly');
    }
  }

  /**
   * Get the CLI binary name (e.g., 'claude', 'codex')
   * @returns {string}
   */
  getBinary() {
    throw new Error('Not implemented: getBinary()');
  }

  /**
   * Get the provider name for display and config
   * @returns {string}
   */
  getName() {
    throw new Error('Not implemented: getName()');
  }

  /**
   * Get provider capabilities
   * @returns {ProviderCapabilities}
   */
  getCapabilities() {
    throw new Error('Not implemented: getCapabilities()');
  }

  /**
   * Build CLI arguments for a main headless session (async spawn).
   * This is the primary long-running session that performs the task.
   *
   * @param {SessionArgs} options
   * @returns {string[]}
   */
  buildSessionArgs(options) {
    throw new Error('Not implemented: buildSessionArgs()');
  }

  /** Qualified drivers own exact argv mapping; permissions come from resolved policy,
   * never legacy session defaults or worker-supplied invocation data. */
  buildWorkerArgs(invocation, profile, permissions) {
    throw new Error('Not implemented: buildWorkerArgs()');
  }

  /**
   * Inspect a trusted host installation, without importing code or running inference.
   * The returned digest binds negative qualification evidence to this exact scope.
   * Install roots and the enforcing boundary must remain protected by the host.
   */
  async inspectWorkerInstallation(options) {
    const owner = await importImpl(import.meta.url, 'models/worker-installation.mjs');
    return owner.inspectWorkerInstallation(this, structuredClone(options));
  }

  /**
   * Bounded version probe plus host-owned negative evidence, never worker claims.
   * Missing, unsupported or changed installations stay DISABLED. No downloads,
   * login, credentials discovery, server startup or managed state is involved.
   */
  async qualifyWorkerInstallation(options) {
    const owner = await importImpl(import.meta.url, 'models/worker-installation.mjs');
    return owner.qualifyWorkerInstallation(this, options);
  }

  async recordWorkerInstallation(options) {
    const owner = await importImpl(import.meta.url, 'models/worker-installation.mjs');
    return owner.recordWorkerInstallation(this, options);
  }

  /**
   * Prepare one policy-resolved invocation through the supported installed path.
   * This only validates/renders data: the conductor still owns path/digest
   * rechecks, launch, observation and verification. No Ralph loop is started.
   * Qualified drivers supply explicit argv; legacy buildSessionArgs defaults
   * must never be used as a fallback for a worker profile.
   *
   * Callers gate-then-launch through `checkWorkerDispatch()` (from
   * `tools/scripts/resource-preflight.mjs`) and `launchIsolatedWorker()` (from
   * `./worker-isolation.mjs`): over resource threshold means queue, pick
   * another qualified host, or reject — never launch. Preparation itself stays
   * launch-free and performs no resource gating (#2954).
   *
   * @param {Object} invocation - Existing workerResolvedInvocation payload
   * @param {Object} qualification - Trusted adapter, cliVersion, requiredControls,
   *   now (epoch milliseconds), platform, current mcp/schema bindings, and optional
   *   merged policy and dataClass from trusted resolution. Observation evidence
   *   (modelObservation or defaultObservation) is required; null effort also
   *   requires the selected role and policy role guidance allowing its absence.
   * @returns {Promise<Object>} A detached typed descriptor; never executes it
   */
  async prepareWorkerInvocation(invocation, qualification) {
    const owner = await importImpl(import.meta.url, 'models/worker-installation.mjs');
    return owner.prepareInstalledWorkerInvocation(this, invocation, qualification);
  }

  /**
   * Build CLI arguments for a short analysis call (spawnSync).
   * Used by OutputAnalyzer, StateAssessor, and ClaudePromptGenerator
   * for quick Claude-powered analysis between iterations.
   *
   * @param {AnalysisArgs} options
   * @returns {string[]}
   */
  buildAnalysisArgs(options) {
    throw new Error('Not implemented: buildAnalysisArgs()');
  }

  /**
   * Map generic model names (opus/sonnet/haiku) to provider-specific models.
   *
   * @param {string} genericModel - Generic model name
   * @returns {string} Provider-specific model name
   */
  mapModel(genericModel) {
    throw new Error('Not implemented: mapModel()');
  }

  /**
   * Check if the provider CLI is available on the system.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    return new Promise((resolve) => {
      const child = spawn(this.getBinary(), ['--version'], {
        stdio: 'pipe',
      });
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
  }

  /**
   * Get the provider CLI version string.
   * @returns {Promise<string|null>}
   */
  async getVersion() {
    return new Promise((resolve) => {
      let output = '';
      const child = spawn(this.getBinary(), ['--version'], {
        stdio: 'pipe',
      });
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });
      child.on('close', (code) => {
        resolve(code === 0 ? output.trim() : null);
      });
      child.on('error', () => resolve(null));
    });
  }

  /**
   * Parse provider-specific output to extract JSON.
   * Default implementation extracts the first JSON object from stdout.
   *
   * @param {string} stdout - Raw stdout from the CLI
   * @returns {Object|null} Parsed JSON object or null
   */
  parseOutput(stdout) {
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }

  /**
   * Get environment variable overrides for headless mode.
   * @returns {Object<string, string>}
   */
  getEnvOverrides() {
    return {};
  }

  /** JSONL written to stdin before bounded process termination, when supported. */
  getAbortInput() { return null; }

  /**
   * Get the path where the provider stores session transcripts.
   *
   * @param {string} sessionId - Session UUID
   * @param {string} workingDir - Working directory path
   * @returns {string|null} Path to transcript file, or null if not supported
   */
  getTranscriptPath(sessionId, workingDir) {
    return null;
  }

  /**
   * Check if a capability is supported, and optionally log a warning.
   *
   * @param {string} capability - Capability name from ProviderCapabilities
   * @param {string} [context] - Context for the warning message
   * @returns {boolean}
   */
  hasCapability(capability) {
    const caps = this.getCapabilities();
    return !!caps[capability];
  }

  /**
   * Log a capability warning when a feature is not supported.
   *
   * @param {string} capability - Capability name
   * @param {string} feature - Human-readable feature description
   */
  warnUnsupported(capability, feature) {
    if (!this.hasCapability(capability)) {
      console.warn(
        `[${this.getName()}] Warning: ${feature} not supported by this provider, skipping`
      );
    }
  }
}

// ============================================================================
// Provider Registry & Factory
// ============================================================================

export async function loadInstalledWorkerAdapters(request) {
  await ensureProvidersRegistered();
  return installedOwner.loadInstalledWorkerAdapters(request);
}

// ============================================================================
// Auto-register built-in providers on import
// ============================================================================

// Lazy imports to avoid circular dependencies - adapters register themselves
// when their modules are loaded. We trigger that here.
async function registerBuiltinProviders() {
  try {
    await import('./claude-adapter.mjs');
  } catch { /* ignore if not found */ }
  try {
    await import('./codex-adapter.mjs');
  } catch { /* ignore if not found */ }
  try {
    await import('./opencode-adapter.mjs');
  } catch { /* ignore if not found */ }
  try {
    await import('./factory-adapter.mjs');
  } catch { /* ignore if not found */ }
  try {
    await import('./pi-adapter.mjs');
    await import('./omp-adapter.mjs');
  } catch { /* ignore if not found */ }
  try {
    await import('./deepseek-harness-adapter.mjs');
  } catch { /* ignore if not found */ }
  // #230: optional / post-experimental. Disabled via AIWG_MUSE_RALPH_ENABLED=0
  // without affecting `aiwg use --provider muse`.
  if (isMuseRalphEnabled()) {
    try {
      await import('./muse-adapter.mjs');
    } catch { /* ignore if not found */ }
  }
}

// Run registration — store promise so callers can await it
const _registrationPromise = registerBuiltinProviders();

/**
 * Ensure all built-in providers are registered before use.
 * Must be awaited before calling createProvider().
 * Optional installed bindings come only from the trusted host registration path.
 */
export async function ensureProvidersRegistered(installed) {
  await _registrationPromise;
  if (installed !== undefined) return loadInstalledWorkerAdapters(installed);
}

export default ProviderAdapter;
