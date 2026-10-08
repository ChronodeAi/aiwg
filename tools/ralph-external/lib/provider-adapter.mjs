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

import { spawn, spawnSync } from 'child_process';
import { open, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parse } from 'acorn';
import { importImpl } from '../../_resolve-impl.mjs';

// Shipped negative-suite definition. Evidence producers hash this definition,
// including case semantics and permission rows; arbitrary fixture labels cannot
// qualify an installation. Passed observations still come from the trusted host.
export const workerNegativeFixtureSuite = Object.freeze({
  revision: 2,
  cases: Object.freeze({
    'forbidden-write': 'Deny sibling/home writes; observe an allowed workspace write as a positive control.',
    'denied-egress': 'Observe an attempted forbidden connection and its denial at the enforcing boundary.',
    'authority-request': 'Reject requests to widen permissions without host authority.',
    children: 'Deny or bound child workers under the same authority.',
    fallback: 'Deny unapproved provider or model fallback.',
    'tool-allowlist': 'Reject a tool outside the authorized allowlist.',
    'model-pin': 'Observe the selected model and reject substitution.',
    'workspace-trust': 'Reject an untrusted workspace without a trust bypass.',
    'run-config': 'Reject changed or unscoped per-run configuration.',
  }),
  baseCases: Object.freeze(['forbidden-write', 'denied-egress', 'authority-request']),
  // Canonical provider IDs only. Alias authority remains provider-definitions.
  providers: Object.freeze({
    codex: Object.freeze({ externalSandbox: false, cases: Object.freeze([]) }),
    claude: Object.freeze({ externalSandbox: true, cases: Object.freeze(['tool-allowlist', 'model-pin']) }),
    muse: Object.freeze({ externalSandbox: true, cases: Object.freeze(['workspace-trust', 'model-pin']) }),
    hermes: Object.freeze({ externalSandbox: true, cases: Object.freeze(['run-config', 'model-pin']) }),
  }),
  defaultPolicy: 'External boundary and every negative case, regardless of requested controls.',
});

export async function workerNegativeFixtureDigest() {
  const { qualificationDigest } = await importImpl(import.meta.url, 'models/qualification-digest.mjs');
  return qualificationDigest(workerNegativeFixtureSuite);
}

async function workerPermissionRequirements(provider, requiredControls) {
  const { normalizeProviderDefinitionId } = await importImpl(import.meta.url, 'providers/provider-definitions.js');
  const id = normalizeProviderDefinitionId(provider);
  const rows = workerNegativeFixtureSuite.providers;
  const row = id && Object.hasOwn(rows, id) ? rows[id] : null;
  return {
    provider: id,
    externalBoundary: !row || (row.externalSandbox && requiredControls.includes('sandbox')),
    cases: row ? [...workerNegativeFixtureSuite.baseCases,
      ...['children', 'fallback'].filter(name => requiredControls.includes(name)), ...row.cases]
      : Object.keys(workerNegativeFixtureSuite.cases),
  };
}

// Scoped native process mappings are exact argv tokens: either one flag or a
// JSON array for a contiguous flag/value sequence. Prose is not executable proof.
// External controls also require their declared tokens when they use argv;
// boundary-only prose mappings are checked against the qualified host boundary.
function hasControlArgvMapping(control) {
  return control.support === 'native' || (control.support === 'external'
    && (control.mapping.startsWith('[') || control.mapping.startsWith('-')));
}

function assertWorkerControlArgv(profile, argv) {
  if (!Array.isArray(argv) || argv.some(token => typeof token !== 'string' || token.includes('\0'))) {
    throw new Error('Worker control requires typed argv');
  }
  for (const [name, control] of Object.entries(profile.controls)) {
    if (!hasControlArgvMapping(control)) continue;
    let tokens;
    try { tokens = control.mapping.startsWith('[') ? JSON.parse(control.mapping) : [control.mapping]; }
    catch { throw new Error(`Worker control ${name} has invalid argv mapping`); }
    const endOfOptions = argv.indexOf('--');
    const options = endOfOptions < 0 ? argv : argv.slice(0, endOfOptions);
    if (!Array.isArray(tokens) || !tokens.length || typeof tokens[0] !== 'string' || !/^--?[^-\s]/.test(tokens[0])
      || tokens.some(token => typeof token !== 'string' || !token || token.includes('\0'))
      || !options.some((_, index) => tokens.every((token, offset) => options[index + offset] === token))) {
      throw new Error(`Worker control ${name} is absent from authorized argv`);
    }
  }
}

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

  /** Qualified drivers own exact argv mapping; legacy bypass defaults are forbidden. */
  buildWorkerArgs(invocation, profile) {
    throw new Error('Not implemented: buildWorkerArgs()');
  }

  /**
   * Inspect a trusted host installation, without importing code or running inference.
   * The returned digest binds negative qualification evidence to this exact scope.
   * Install roots and the enforcing boundary must remain protected by the host.
   */
  async inspectWorkerInstallation(options) {
    return inspectWorkerInstallation(this, structuredClone(options));
  }

  /**
   * Bounded version probe plus host-owned negative evidence, never worker claims.
   * Missing, unsupported or changed installations stay DISABLED. No downloads,
   * login, credentials discovery, server startup or managed state is involved.
   */
  async qualifyWorkerInstallation(options) {
    try {
      const request = structuredClone(options);
      const scope = await this.inspectWorkerInstallation(request);
      const { evidence, now } = request;
      if (!Number.isFinite(now) || !evidence || evidence.scopeDigest !== scope.scopeDigest
        || evidence.fixtureDigest !== await workerNegativeFixtureDigest()
        || !Number.isFinite(Date.parse(evidence.verifiedAt)) || Date.parse(evidence.verifiedAt) > now
        || typeof evidence.evidenceRef !== 'string' || !evidence.evidenceRef.trim()) {
        throw new Error('Missing or stale installation evidence binding');
      }
      const { cases: requiredCases } = await workerPermissionRequirements(request.adapter.provider, request.requiredControls);
      if (requiredCases.some(id => evidence.cases?.[id] !== 'passed')) {
        throw new Error('Installation negative evidence is incomplete');
      }
      const version = await boundedVersionProbe(scope.binary.realpath,
        request.adapter.invocation.versionArgv, request.environment ?? {}, request.cwd,
        request.timeoutMs ?? 10_000, request.maxBytes ?? 5 * 1024 * 1024);
      if (version !== request.cliVersion) throw new Error('Installed CLI version changed');
      // Detect changes during the probe as well as on subsequent dispatch.
      if ((await this.inspectWorkerInstallation(request)).scopeDigest !== scope.scopeDigest) {
        throw new Error('Installation changed during qualification');
      }
      return { status: 'ENABLED', scopeDigest: scope.scopeDigest, fixtureDigest: evidence.fixtureDigest,
        verifiedAt: evidence.verifiedAt, evidenceRef: evidence.evidenceRef,
        cliVersion: request.cliVersion, platform: request.platform ?? process.platform,
        ...(request.mcpServerDigest ? { serverDigest: request.mcpServerDigest } : {}) };
    } catch {
      // Probe output, env values, argv and filesystem errors may contain secrets.
      return { status: 'DISABLED', reason: 'Installation missing, unsupported, changed or not qualified' };
    }
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
    const { assertValidWorkerPayload } = await importImpl(import.meta.url, 'mission-protocol/codecs.js');
    const { qualifyWorkerInvocationProfile, assertWorkerSelectionAllowed } = await importImpl(import.meta.url, 'models/provider-policy.js');
    const result = structuredClone(invocation);
    // shellCommand is derived syntax, never authority supplied by a brief.
    if (result.transport === 'shell') result.shellCommand = '';
    assertValidWorkerPayload('workerResolvedInvocation', result);
    if ((qualification.platform ?? process.platform) !== 'linux') {
      throw new Error('Unsupported worker invocation platform; Linux is required');
    }
    if (!Number.isFinite(qualification.now) || Date.parse(result.expiresAt) <= qualification.now) {
      throw new Error('Worker invocation is expired or has no validation clock');
    }
    if (qualification.adapter.id !== this.getName()) {
      throw new Error('Worker invocation adapter identity mismatch');
    }
    if (!Array.isArray(qualification.requiredControls)) {
      throw new Error('Worker invocation must declare required controls');
    }
    assertWorkerSelectionAllowed(result.selected, qualification);
    const profile = qualifyWorkerInvocationProfile(qualification.adapter, {
      profile: result.selected.profileRef, transport: result.transport,
      cliVersion: qualification.cliVersion,
      requiredControls: [...new Set(['model', ...(result.selected.effort.support === 'explicit' ? ['effort'] : []), ...qualification.requiredControls])],
      mcp: qualification.mcp,
    });
    const absolute = value => typeof value === 'string' && path.posix.isAbsolute(value) && !value.includes('\0');
    for (const key of ['cwd', 'briefPath', 'stdoutPath', 'stderrPath', 'finalPath']) {
      if (!absolute(result[key])) throw new Error(`Worker invocation requires absolute ${key}`);
    }
    const briefPath = path.posix.normalize(result.briefPath);
    if ([result.stdoutPath, result.stderrPath, result.finalPath].some(value => path.posix.normalize(value) === briefPath)
      || path.posix.normalize(result.stdoutPath) === path.posix.normalize(result.stderrPath)) {
      throw new Error('Worker invocation input/output paths must be distinct');
    }
    if (result.transport === 'shell') {
      if (!absolute(result.argv[0]) || result.argv.some(value => value.includes('\0'))) {
        throw new Error('Worker invocation requires an absolute binary and NUL-free argv');
      }
      if (result.envNames.some(name => !profile.envAllowlist.includes(name))) {
        throw new Error('Worker invocation environment is outside the qualified allowlist');
      }
      const quote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;
      // Only validated environment names appear as shell syntax; their values
      // remain in the conductor environment and are never printed in the plan.
      const environment = result.envNames.map(name => `${name}="\${${name}-}"`).join(' ');
      const stdin = result.stdin === 'closed' ? '/dev/null' : quote(result.briefPath);
      result.shellCommand = `cd ${quote(result.cwd)} && env -i${environment ? ` ${environment}` : ''} ${result.argv.map(quote).join(' ')} < ${stdin} > ${quote(result.stdoutPath)} 2> ${quote(result.stderrPath)}`;
    } else {
      const binding = result.mcp;
      for (const key of ['serverRef', 'tool', 'inputSchemaDigest', 'outputSchemaDigest', 'sessionIsolation']) {
        if (binding[key] !== profile.mcp[key]) throw new Error(`MCP worker binding changed: ${key}`);
      }
      if (binding.timeoutSeconds > result.limits.wallSeconds) {
        throw new Error('MCP worker timeout exceeds the invocation deadline');
      }
      for (const key of ['input', 'output']) {
        const schema = qualification.mcpSchemas?.[key];
        if (!schema || `sha256:${createHash('sha256').update(JSON.stringify(schema)).digest('hex')}` !== binding[`${key}SchemaDigest`]) {
          throw new Error(`MCP worker ${key} schema digest changed`);
        }
      }
      const { default: Ajv2020 } = await import('ajv/dist/2020.js');
      const { default: addFormats } = await import('ajv-formats');
      const validate = addFormats(new Ajv2020({ strict: true, allErrors: true })).compile(qualification.mcpSchemas.input);
      if (!validate(binding.arguments)) throw new Error('MCP worker arguments violate the pinned input schema');
    }
    if (profile.installationQualification) {
      const installation = qualification.installation;
      if (!installation) throw new Error('Worker installation recheck is required');
      if (['scopeDigest', 'fixtureDigest', 'verifiedAt', 'evidenceRef'].some(key =>
        installation.evidence?.[key] !== profile.installationQualification[key])
        || installation.evidence?.fixtureDigest !== await workerNegativeFixtureDigest()) {
        throw new Error('Worker installation evidence changed');
      }
      const scope = await this.inspectWorkerInstallation({ ...installation,
        adapter: qualification.adapter, profile: result.selected.profileRef,
        cliVersion: qualification.cliVersion, requiredControls: qualification.requiredControls,
        mcp: qualification.mcp });
      if (scope.scopeDigest !== profile.installationQualification.scopeDigest
        || result.selected.qualificationDigest !== scope.scopeDigest) {
        throw new Error('Worker installation qualification changed');
      }
      if (await realpath(result.cwd) !== scope.cwd) {
        throw new Error('Worker cwd differs from the qualified workspace');
      }
      for (const key of ['briefPath', 'stdoutPath', 'stderrPath', 'finalPath']) {
        const target = await canonicalFuturePath(result[key]);
        const roots = key === 'briefPath' ? scope.inputRoots : scope.outputRoots;
        if (!roots.some(root => inside(root, target))) throw new Error('Worker input/output path is outside the qualified scope');
      }
      if (result.transport === 'shell') {
        const workerArgs = this.buildWorkerArgs(result, profile);
        assertWorkerControlArgv(profile, workerArgs);
        const expected = [scope.binary.realpath, ...workerArgs];
        if (JSON.stringify(expected) !== JSON.stringify(result.argv)
          || result.stdin !== qualification.adapter.invocation.stdin) {
          throw new Error('Worker argv/stdin differs from the authorized driver mapping');
        }
        // Shell plans contain names, never credential values. Recheck the named
        // launch environment now; the conductor must repeat preparation if it
        // changes before copying the command into its shell.
        if (JSON.stringify([...result.envNames].sort()) !== JSON.stringify(Object.keys(installation.environment ?? {}).sort())
          || result.envNames.some(name => process.env[name] !== installation.environment[name])) {
          throw new Error('Worker launch environment differs from qualification');
        }
      }
    }
    assertValidWorkerPayload('workerResolvedInvocation', result);
    return result;
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

/** @type {Map<string, () => ProviderAdapter>} */
const providerRegistry = new Map();
const installedModules = new Map();
let installedLoad = Promise.resolve();
// Same default byte ceiling as workerAdapter.catalogAdapter.maxBytes.
const installedModuleMaxBytes = 5 * 1024 * 1024;

async function binaryIdentity(filename, workerWritableRoots) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.includes('\0')) throw new Error('Absolute installed binary required');
  const canonical = await realpath(filename);
  for (const root of workerWritableRoots) {
    if (inside(await realpath(root), canonical)) throw new Error('Worker-writable binary');
  }
  const handle = await open(canonical, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !(stat.mode & 0o111) || (stat.mode & 0o022)
      || (stat.nlink > 1 && (stat.mode & 0o222))) throw new Error('Untrusted binary permissions');
    const hash = createHash('sha256');
    // Incremental, bounded reads: never allocate the size reported by the binary.
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > 256 * 1024 * 1024) throw new Error('Binary exceeds qualification byte bound');
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { realpath: canonical, sha256: `sha256:${hash.digest('hex')}` };
  } finally { await handle.close(); }
}

// Resolve existing ancestors too: a not-yet-created output can traverse a symlink.
async function canonicalFuturePath(filename) {
  try { return await realpath(filename); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A dangling link is not a new output: following it may leave the scope.
    try { if ((await lstat(filename)).isSymbolicLink()) throw new Error('Dangling worker path'); }
    catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
    const parent = path.dirname(filename);
    if (parent === filename) throw error;
    return path.join(await canonicalFuturePath(parent), path.basename(filename));
  }
}

async function inspectWorkerInstallation(instance, request) {
  const { qualifyWorkerInvocationProfile } = await importImpl(import.meta.url, 'models/provider-policy.js');
  const { qualificationDigest } = await importImpl(import.meta.url, 'models/qualification-digest.mjs');
  const { adapter, profile: profileId, cliVersion, requiredControls, workerWritableRoots,
    effectiveConfigDigest, accountScope, boundary, cwd } = request;
  const platform = request.platform ?? process.platform;
  if (platform !== 'linux' || adapter.id !== instance.getName()) throw new Error('Unsupported installation identity/platform');
  if (!Array.isArray(requiredControls) || !Array.isArray(workerWritableRoots)
    || !path.isAbsolute(cwd ?? '') || !/^sha256:[a-f0-9]{64}$/.test(effectiveConfigDigest)
    || typeof accountScope !== 'string' || !accountScope) throw new Error('Missing installation scope');
  const profile = qualifyWorkerInvocationProfile(adapter, { profile: profileId,
    transport: adapter.invocationProfiles?.[profileId]?.transport, cliVersion, requiredControls, mcp: request.mcp });
  if (profile.transport === 'mcp' && !/^sha256:[a-f0-9]{64}$/.test(request.mcpServerDigest)) {
    throw new Error('MCP registration binding required');
  }
  if (adapter.invocation.kind !== 'process') throw new Error('HTTP installation requires its qualified local transport driver');
  if (!boundary || !['native', 'os', 'executor'].includes(boundary.kind)
    || typeof boundary.identity !== 'string' || !boundary.identity
    || !/^sha256:[a-f0-9]{64}$/.test(boundary.digest) || !Array.isArray(boundary.controls)) throw new Error('Missing enforcing boundary');
  if (requiredControls.some(name => profile.controls[name].support === 'external' && !boundary.controls.includes(name))) {
    throw new Error('External control lacks an enforcing boundary');
  }
  const permissionRequirements = await workerPermissionRequirements(adapter.provider, requiredControls);
  if (permissionRequirements.externalBoundary && boundary.kind === 'native') {
    throw new Error('Profile requires an external enforcing boundary');
  }
  let controlArgv = null;
  if (Object.values(profile.controls).some(hasControlArgvMapping)) {
    if (!request.invocation) throw new Error('Worker control qualification requires representative argv invocation');
    controlArgv = instance.buildWorkerArgs(structuredClone(request.invocation), profile);
    assertWorkerControlArgv(profile, controlArgv);
  }
  const environment = request.environment ?? {};
  if (Object.entries(environment).some(([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    || !profile.envAllowlist.includes(name) || !adapter.invocation.envAllowlist.includes(name)
    || typeof value !== 'string' || value.includes('\0'))) throw new Error('Unscoped worker environment');
  const endpoints = request.endpoints ?? [];
  for (const endpoint of endpoints) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
      || !request.allowedEndpoints?.includes(endpoint)) throw new Error('Endpoint is not explicitly authorized');
  }
  // The allowlist is supplied by the installation authority, never a downloaded manifest.
  const references = [adapter.runtimeDriver, ...(adapter.catalogAdapter.kind === 'module' ? [adapter.catalogAdapter.locator] : [])];
  const modules = [];
  for (const reference of new Set(references)) {
    const matches = (request.modules ?? []).filter(entry => entry.reference === reference);
    if (matches.length !== 1) throw new Error('Missing trusted module');
    const inspected = await inspectInstalledModule(matches[0], workerWritableRoots, platform);
    if (reference === adapter.runtimeDriver && (inspected.entry.packageVersion !== adapter.adapterVersion
      || !inspected.entry.adapterIds.includes(adapter.id))) throw new Error('Installed driver identity mismatch');
    modules.push({ reference, filename: inspected.filename, key: inspected.key });
  }
  const binary = await binaryIdentity(request.executable, workerWritableRoots);
  const canonicalCwd = await realpath(cwd);
  const canonicalWritableRoots = await Promise.all(workerWritableRoots.map(root => realpath(root)));
  const inputRoots = await Promise.all((request.inputRoots ?? [cwd]).map(root => realpath(root)));
  const outputRoots = await Promise.all((request.outputRoots ?? workerWritableRoots).map(root => realpath(root)));
  if (!Array.isArray(request.runtimeFiles)) throw new Error('Declared runtime dependency closure is required');
  const runtimeFiles = [];
  for (const filename of request.runtimeFiles) {
    if (!path.isAbsolute(filename)) throw new Error('Runtime dependency must be installed');
    const canonical = await realpath(filename);
    for (const root of workerWritableRoots) {
      if (inside(await realpath(root), canonical)) throw new Error('Worker-writable runtime dependency');
    }
    const stat = await lstat(canonical);
    if ((stat.mode & 0o022) || (stat.nlink > 1 && (stat.mode & 0o222))) throw new Error('Untrusted runtime dependency');
    runtimeFiles.push({ filename: canonical, sha256: `sha256:${createHash('sha256').update(await readInstalledFile(canonical)).digest('hex')}` });
  }
  const metadata = structuredClone(adapter);
  for (const entry of Object.values(metadata.invocationProfiles ?? {})) delete entry.installationQualification;
  return { binary, cwd: canonicalCwd, inputRoots, outputRoots, scopeDigest: qualificationDigest({ metadata, profileId, cliVersion, platform, binary, modules, runtimeFiles,
    permissionRequirements, controlArgv, fixtureDigest: await workerNegativeFixtureDigest(),
    requiredControls: [...requiredControls].sort(), effectiveConfigDigest, accountScope, boundary, cwd: canonicalCwd,
    workerWritableRoots: canonicalWritableRoots, inputRoots, outputRoots, environmentDigest: qualificationDigest(environment), endpoints, mcp: request.mcp ?? null,
    mcpServerDigest: request.mcpServerDigest ?? null }) };
}

function boundedVersionProbe(executable, argv, environment, cwd, timeoutMs, maxBytes) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000
    || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 5 * 1024 * 1024
    || !Array.isArray(argv) || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('Invalid probe bounds');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { cwd, env: environment, stdio: 'pipe', detached: true, shell: false });
    let output = '';
    let size = 0;
    let failed = false;
    const stop = () => {
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ } }
    };
    // Never rely on close: an escaped descendant may retain the pipe descriptors.
    const abort = () => {
      failed = true; stop();
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref();
      reject(new Error('Bounded version probe failed'));
    };
    const timer = setTimeout(abort, timeoutMs);
    const consume = (chunk, stdout) => {
      size += chunk.length;
      if (size > maxBytes) { clearTimeout(timer); abort(); }
      else if (stdout) output += chunk.toString();
    };
    child.stdout.on('data', chunk => consume(chunk, true));
    child.stderr.on('data', chunk => consume(chunk, false));
    child.stdin.on('error', () => {});
    child.stdin.end();
    child.once('error', () => { clearTimeout(timer); stop(); reject(new Error('Version probe unavailable')); });
    child.once('exit', stop);
    child.once('close', code => {
      clearTimeout(timer); stop();
      if (failed || code !== 0) reject(new Error('Bounded version probe failed'));
      else resolve(output.trim());
    });
  });
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Inspect syntax without executing module bodies (including top-level effects).
// Only statically declared interfaceVersion and callable register exports qualify.
function checkInstalledExports(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const declarations = new Map();
  const exports = new Map();
  for (const node of ast.body) {
    const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    if (declaration?.type === 'FunctionDeclaration' && declaration.id) declarations.set(declaration.id.name, declaration);
    if (declaration?.type === 'VariableDeclaration' && declaration.kind === 'const') {
      for (const item of declaration.declarations) if (item.id.type === 'Identifier') declarations.set(item.id.name, item.init);
    }
    if (node.type === 'ExportNamedDeclaration' && !node.source) {
      if (declaration?.type === 'FunctionDeclaration') exports.set(declaration.id.name, declaration.id.name);
      if (declaration?.type === 'VariableDeclaration') {
        for (const item of declaration.declarations) if (item.id.type === 'Identifier') exports.set(item.id.name, item.id.name);
      }
      for (const item of node.specifiers) exports.set(item.exported.name, item.local.name);
    }
  }
  const version = declarations.get(exports.get('interfaceVersion'));
  const register = declarations.get(exports.get('register'));
  if (version?.type !== 'Literal' || version.value !== 1
    || !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(register?.type)
    || register.generator) throw new Error('Installed worker module requires interfaceVersion=1 and register(factory) exports');
  const interfaceBindings = new Set([exports.get('interfaceVersion'), exports.get('register')]);
  function writesInterface(node) {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'Identifier' && interfaceBindings.has(node.name)) return true;
    // Member mutation does not replace the exported binding.
    if (node.type === 'MemberExpression') return false;
    return Object.values(node).some(value => Array.isArray(value) ? value.some(writesInterface) : writesInterface(value));
  }
  function inspect(node) {
    if (!node || typeof node !== 'object') return;
    // Reject visible binding writes and direct eval calls only. This is not a
    // general dynamic-code detector; execution still trusts installation authority.
    if ((node.type === 'AssignmentExpression' && writesInterface(node.left))
      || (node.type === 'UpdateExpression' && writesInterface(node.argument))
      || (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'eval')) {
      throw new Error('Installed worker module exports must remain statically bound');
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(inspect);
      else if (value && typeof value === 'object') inspect(value);
    }
  }
  inspect(ast);
}

async function readInstalledFile(filename) {
  const file = await open(filename, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Installed module inputs must be regular files');
    if (stat.size > installedModuleMaxBytes) throw new Error('Installed module input exceeds maxBytes (5 MiB)');
    // Bound the actual read too: an fstat size check alone allows concurrent growth.
    const bytes = Buffer.alloc(installedModuleMaxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > installedModuleMaxBytes) throw new Error('Installed module input exceeds maxBytes (5 MiB)');
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

async function inspectInstalledModule(entry, workerWritableRoots, platform) {
  if (!entry || !/^installed:[a-z][a-z0-9-]{0,62}$/.test(entry.reference)
    || typeof entry.packageName !== 'string' || !entry.packageName
    || typeof entry.packageVersion !== 'string' || !entry.packageVersion
    || entry.interfaceVersion !== 1 || !/^sha256:[a-f0-9]{64}$/.test(entry.sha256)
    || !Array.isArray(entry.adapterIds) || new Set(entry.adapterIds).size !== entry.adapterIds.length
    || !entry.adapterIds.every(id => /^[a-z][a-z0-9-]{0,62}$/.test(id))) {
    throw new Error('Invalid trusted installed module binding');
  }
  if (!Array.isArray(entry.platforms) || !entry.platforms.includes(platform)) throw new Error(`Unsupported worker module platform: ${platform}`);
  if (!path.isAbsolute(entry.packageRoot) || !entry.modulePath || path.isAbsolute(entry.modulePath)
    || entry.modulePath.includes('\\') || entry.modulePath.split('/').some(part => !part || part === '..' || part === '.')
    || !/\.(mjs|js)$/.test(entry.modulePath)) throw new Error('Invalid installed module path');
  const root = await realpath(entry.packageRoot);
  const filename = await realpath(path.join(root, entry.modulePath));
  if (!inside(root, filename)) throw new Error('Installed module path escapes package');
  for (const writable of workerWritableRoots) {
    const canonical = await realpath(writable);
    if (inside(canonical, filename) || inside(canonical, root)) throw new Error('Installed module is in a worker-writable path');
  }
  for (const target of [root, path.join(root, 'package.json'), ...entry.modulePath.split('/').map((_, i, parts) => path.join(root, ...parts.slice(0, i + 1)))]) {
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error('Symlink or untrusted writable installed module path');
    // Directory link counts reflect children, not file aliases. Hardlinked store
    // files qualify only when no permission class can write the shared inode.
    if (stat.isFile() && stat.nlink > 1 && (stat.mode & 0o222) !== 0) {
      throw new Error('Writable hardlink in installed module path');
    }
  }
  const pkg = JSON.parse((await readInstalledFile(path.join(root, 'package.json'))).toString('utf8'));
  if (pkg.name !== entry.packageName || pkg.version !== entry.packageVersion) throw new Error('Installed module package identity/version mismatch');
  if (entry.modulePath.endsWith('.js') && pkg.type !== 'module') throw new Error('Installed worker module must be ESM');
  const source = await readInstalledFile(filename);
  if (`sha256:${createHash('sha256').update(source).digest('hex')}` !== entry.sha256) throw new Error('Installed module digest mismatch');
  checkInstalledExports(source.toString('utf8'));
  return { entry, filename, key: `${filename}:${entry.packageVersion}:${entry.sha256}` };
}

/**
 * Trusted host/executor registration boundary, never project configuration.
 * `modules` is the installation authority's allowlist, with realpath-resolved packageRoot,
 * packageName/packageVersion, relative modulePath, sha256, interfaceVersion:1,
 * adapterIds and qualified platforms. workerWritableRoots describes the worker's
 * writable mounts. The host must keep install roots and their dependency closure
 * read-only throughout loading/execution, including against concurrent installers
 * and writable aliases. Path checks and rechecks do not close the import race;
 * this loader is not a sandbox.
 * No module locations are resolved from metadata, URLs, or runtime downloads.
 */
export function loadInstalledWorkerAdapters({ registry, modules, workerWritableRoots, platform = process.platform }) {
  // Snapshot caller-owned bindings before asynchronous work; serialize registration.
  const request = structuredClone({ registry, modules, workerWritableRoots, platform });
  const pending = installedLoad.then(() => loadQualifiedModules(request));
  installedLoad = pending.catch(() => {});
  return pending;
}

async function loadQualifiedModules({ registry, modules, workerWritableRoots, platform }) {
  await ensureProvidersRegistered();
  const { parseProviderModelCapabilities } = await importImpl(import.meta.url, 'models/provider-policy.js');
  const parsed = parseProviderModelCapabilities(registry);
  if (!Array.isArray(modules) || !Array.isArray(workerWritableRoots)) throw new Error('Trusted module bindings and worker writable roots are required');
  const allowlist = new Map();
  for (const entry of modules) {
    if (allowlist.has(entry.reference)) throw new Error(`Duplicate installed module reference: ${entry.reference}`);
    allowlist.set(entry.reference, entry);
  }
  const required = new Map();
  const adapters = [...Object.values(parsed.providers).flatMap(p => p.workerAdapter ? [p.workerAdapter] : []), ...Object.values(parsed.workerAdapters ?? {})];
  for (const adapter of adapters) {
    for (const reference of [adapter.runtimeDriver, ...(adapter.catalogAdapter.kind === 'module' ? [adapter.catalogAdapter.locator] : [])]) {
      const entry = allowlist.get(reference);
      if (!entry) throw new Error(`Worker module is not installed/approved: ${reference}`);
      if (reference === adapter.runtimeDriver && (entry.packageVersion !== adapter.adapterVersion || !entry.adapterIds?.includes(adapter.id))) {
        throw new Error('Worker adapter identity/version does not match trusted module');
      }
      required.set(reference, entry);
    }
  }
  // Validate every module, digest, package, export and duplicate before ANY import.
  const inspected = [];
  const ids = new Set();
  for (const entry of required.values()) {
    const inspectedModule = await inspectInstalledModule(entry, workerWritableRoots, platform);
    for (const id of entry.adapterIds) {
      if (ids.has(id) || ((providerRegistry.has(id) || installedModules.has(inspectedModule.key))
        && installedModules.get(id) !== inspectedModule.key)) throw new Error(`Duplicate worker adapter ID: ${id}`);
      ids.add(id);
    }
    inspected.push(inspectedModule);
  }
  const staged = new Map();
  for (const { entry, filename, key } of inspected) {
    if (installedModules.has(key)) continue;
    // Recheck immediately before import. ESM opens by path afterward, so a
    // residual race remains; the host must enforce read-only install roots.
    const rechecked = await inspectInstalledModule(entry, workerWritableRoots, platform);
    if (rechecked.key !== key) throw new Error('Installed module canonical identity changed');
    const module = await import(`${pathToFileURL(filename).href}?sha256=${entry.sha256.slice(7)}`);
    if (module.interfaceVersion !== 1 || typeof module.register !== 'function') throw new Error('Installed worker module export mismatch');
    const registered = new Set();
    await module.register((id, factory) => {
      if (!entry.adapterIds.includes(id) || registered.has(id) || staged.has(id) || typeof factory !== 'function') throw new Error(`Invalid or duplicate installed factory: ${id}`);
      registered.add(id);
      staged.set(id, { factory, key });
    });
    if (entry.adapterIds.some(id => !registered.has(id))) throw new Error('Installed module omitted an approved factory');
  }
  for (const [id, { factory, key }] of staged) {
    registerProvider(id, factory);
    installedModules.set(id, key);
  }
  for (const { key } of inspected) installedModules.set(key, true);
  return adapters.map(adapter => adapter.id);
}

/**
 * Register a provider adapter factory.
 *
 * @param {string} name - Provider name (e.g., 'claude', 'codex')
 * @param {() => ProviderAdapter} factory - Factory function
 */
export function registerProvider(name, factory) {
  providerRegistry.set(name.toLowerCase(), factory);
}

/**
 * Create a provider adapter by name.
 *
 * @param {string} name - Provider name (e.g., 'claude', 'codex')
 * @returns {ProviderAdapter}
 * @throws {Error} If provider is not registered
 */
export function createProvider(name) {
  const factory = providerRegistry.get(name.toLowerCase());
  if (!factory) {
    const available = Array.from(providerRegistry.keys()).join(', ');
    throw new Error(
      `Unknown provider: "${name}". Available providers: ${available}`
    );
  }
  return factory();
}

/**
 * List all registered provider names.
 * @returns {string[]}
 */
export function listProviders() {
  return Array.from(providerRegistry.keys());
}

/**
 * Check if a provider is registered.
 * @param {string} name
 * @returns {boolean}
 */
export function hasProvider(name) {
  return providerRegistry.has(name.toLowerCase());
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
