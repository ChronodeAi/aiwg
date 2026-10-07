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

  /**
   * Prepare one policy-resolved invocation through the supported installed path.
   * This only validates/renders data: the conductor still owns path/digest
   * rechecks, launch, observation and verification. No Ralph loop is started.
   * Qualified drivers supply explicit argv; legacy buildSessionArgs defaults
   * must never be used as a fallback for a worker profile.
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
