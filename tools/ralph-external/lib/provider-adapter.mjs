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
import { createWorkerHealthObserver, observeProviderHealthEvent } from './worker-health.mjs';

/**
 * Thrown by {@link parseStrictWorkerJson} with a stable `code` so callers can
 * map a scan failure to a specific contract-violation message without
 * string-matching free-text.
 */
class StrictJsonScanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * RFC 8259 JSON parser used on every strict worker-final path (JSONL lines,
 * `format: 'json'`, and the MCP `content[0].text`/top-level envelope) instead
 * of `JSON.parse`. `JSON.parse` silently keeps the LAST value when an object
 * repeats a member name — RFC 8259 §4 explicitly leaves this to the
 * implementation, and V8 picks "last wins". That lets a forged worker final
 * smuggle a second, hidden value past a first one: a trailing duplicate
 * `"status":"completed"` can overwrite an earlier `"status":"failed"`, or a
 * trailing duplicate `"type":"result"` can collapse a `"type":"message"`
 * framing envelope into a bogus result in one line (#2890 BLOCKER 1+2).
 *
 * This scanner tracks member names per object independently at every
 * nesting level (a sibling object may reuse a name the scanner already saw
 * in its parent or an earlier sibling) and rejects any object that repeats
 * one. Names are compared only after the scanner has fully decoded them —
 * resolving `\"`, other single-character escapes, and `\uXXXX` escapes
 * (including surrogate pairs, since JS string concatenation of two decoded
 * UTF-16 code units forms the pair automatically) — so an escape-obfuscated
 * collision (`"status"` vs `"status"`) is caught exactly like a literal
 * one. A non-colliding unknown key, escaped or not, is left for the existing
 * `additionalProperties: false` schema check to reject, unchanged.
 *
 * Nesting depth is bounded during the scan (not only afterward, by
 * `boundedJson()`'s post-parse walk) so pathological depth fails fast with a
 * clear `DEPTH` code instead of relying on a recursive-descent stack
 * overflow to be caught as a generic syntax error.
 *
 * @param {string} text - Decoded JSON text (already UTF-8 validated by the caller)
 * @param {number} maxDepth - Same bound as `WORKER_MAX_NESTING_DEPTH`; root value is depth 1
 * @returns {unknown}
 */
function parseStrictWorkerJson(text, maxDepth) {
  const length = text.length;
  let index = 0;

  function fail(code, message) {
    throw new StrictJsonScanError(code, `${message} (offset ${index})`);
  }

  function skipWhitespace() {
    while (index < length) {
      const code = text.charCodeAt(index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) index += 1;
      else break;
    }
  }

  function parseValue(depth) {
    skipWhitespace();
    if (index >= length) fail('SYNTAX', 'Unexpected end of JSON input');
    const code = text.charCodeAt(index);
    if (code === 0x7b) return parseObject(depth);
    if (code === 0x5b) return parseArray(depth);
    if (code === 0x22) return parseString();
    if (code === 0x2d || (code >= 0x30 && code <= 0x39)) return parseNumber();
    if (text.startsWith('true', index)) { index += 4; return true; }
    if (text.startsWith('false', index)) { index += 5; return false; }
    if (text.startsWith('null', index)) { index += 4; return null; }
    fail('SYNTAX', 'Unexpected token');
  }

  function parseObject(depth) {
    if (depth > maxDepth) fail('DEPTH', 'Worker nesting depth exceeds bound');
    index += 1; // {
    const result = {};
    const seen = new Set();
    skipWhitespace();
    if (text.charCodeAt(index) === 0x7d) { index += 1; return result; }
    for (;;) {
      skipWhitespace();
      if (text.charCodeAt(index) !== 0x22) fail('SYNTAX', 'Expected object member name');
      const key = parseString();
      if (seen.has(key)) fail('DUPLICATE', `Duplicate object member name ${JSON.stringify(key)}`);
      seen.add(key);
      skipWhitespace();
      if (text.charCodeAt(index) !== 0x3a) fail('SYNTAX', 'Expected colon after object member name');
      index += 1;
      // Define, never assign: assignment would invoke the inherited __proto__
      // setter, hiding the member from own-key validation and diverging from
      // JSON.parse, which creates an ordinary own property.
      Object.defineProperty(result, key, { value: parseValue(depth + 1), enumerable: true, writable: true, configurable: true });
      skipWhitespace();
      const delimiter = text.charCodeAt(index);
      if (delimiter === 0x2c) { index += 1; continue; }
      if (delimiter === 0x7d) { index += 1; break; }
      fail('SYNTAX', 'Expected , or } in object');
    }
    return result;
  }

  function parseArray(depth) {
    if (depth > maxDepth) fail('DEPTH', 'Worker nesting depth exceeds bound');
    index += 1; // [
    const result = [];
    skipWhitespace();
    if (text.charCodeAt(index) === 0x5d) { index += 1; return result; }
    for (;;) {
      result.push(parseValue(depth + 1));
      skipWhitespace();
      const delimiter = text.charCodeAt(index);
      if (delimiter === 0x2c) { index += 1; continue; }
      if (delimiter === 0x5d) { index += 1; break; }
      fail('SYNTAX', 'Expected , or ] in array');
    }
    return result;
  }

  function parseString() {
    index += 1; // opening quote
    let value = '';
    for (;;) {
      if (index >= length) fail('SYNTAX', 'Unterminated string');
      const code = text.charCodeAt(index);
      if (code === 0x22) { index += 1; return value; }
      if (code === 0x5c) {
        index += 1;
        const escape = text[index];
        if (escape === undefined) fail('SYNTAX', 'Unterminated escape sequence');
        switch (escape) {
          case '"': value += '"'; index += 1; break;
          case '\\': value += '\\'; index += 1; break;
          case '/': value += '/'; index += 1; break;
          case 'b': value += '\b'; index += 1; break;
          case 'f': value += '\f'; index += 1; break;
          case 'n': value += '\n'; index += 1; break;
          case 'r': value += '\r'; index += 1; break;
          case 't': value += '\t'; index += 1; break;
          case 'u': {
            const hex = text.slice(index + 1, index + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('SYNTAX', 'Invalid unicode escape');
            // Decoded code unit is appended as-is; two consecutive decoded
            // surrogate halves recombine into one character automatically
            // through normal JS UTF-16 string concatenation.
            value += String.fromCharCode(parseInt(hex, 16));
            index += 5;
            break;
          }
          default: fail('SYNTAX', 'Invalid escape sequence');
        }
      } else if (code < 0x20) {
        fail('SYNTAX', 'Unescaped control character in string');
      } else {
        value += text[index];
        index += 1;
      }
    }
  }

  function parseNumber() {
    const start = index;
    if (text.charCodeAt(index) === 0x2d) index += 1;
    if (text.charCodeAt(index) === 0x30) {
      index += 1;
    } else if (text.charCodeAt(index) >= 0x31 && text.charCodeAt(index) <= 0x39) {
      index += 1;
      while (text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x39) index += 1;
    } else fail('SYNTAX', 'Invalid number');
    if (text.charCodeAt(index) === 0x2e) {
      index += 1;
      if (!(text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x39)) fail('SYNTAX', 'Invalid number fraction');
      while (text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x39) index += 1;
    }
    if (text.charCodeAt(index) === 0x65 || text.charCodeAt(index) === 0x45) {
      index += 1;
      if (text.charCodeAt(index) === 0x2b || text.charCodeAt(index) === 0x2d) index += 1;
      if (!(text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x39)) fail('SYNTAX', 'Invalid number exponent');
      while (text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x39) index += 1;
    }
    return Number(text.slice(start, index));
  }

  const result = parseValue(1);
  skipWhitespace();
  if (index !== length) fail('SYNTAX', 'Unexpected trailing characters after JSON value');
  return result;
}

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
 * Token and spend accounting read from one stream event. Counters are zero
 * when the matching field is absent; the `has*` flags record whether the
 * provider reported the field at all, so "observed 0" stays distinct from
 * "cannot observe" (#1766).
 *
 * @typedef {Object} StreamUsage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheCreationInputTokens
 * @property {number} cacheReadInputTokens
 * @property {number} totalTokens
 * @property {number} costUsd - Spend in USD
 * @property {boolean} hasTokenField - Any token field was a finite number
 * @property {boolean} hasCostField - A cost field was a finite number
 * @property {boolean} hasUsage - `hasTokenField || hasCostField`
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
   * Legacy, synchronous contract only: always returns `Object|null`, never a
   * Promise. Group-mode/worker-final parsing is a distinct async contract —
   * call `parseWorkerFinal()` (or `parseWorkerOutput()` directly), never this
   * method with a `groupMode` flag. An un-awaited Promise is a truthy object,
   * so a caller that mixed the two contracts through one return type could
   * mistake a pending parse for a successful legacy result (#2890 NOTE 6).
   *
   * @param {string} stdout - Raw stdout from the CLI
   * @returns {Object|null} Parsed JSON, or null if none found/malformed
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
   * Strict group-mode entry point. Always returns a Promise; callers MUST
   * await it. Thin, intentionally-named alias over `parseWorkerOutput()` so
   * group-mode call sites never have to pass a `groupMode` flag into the
   * legacy, synchronous `parseOutput()` contract above.
   *
   * @param {string|Uint8Array|Object} output
   * @param {Object} [options] - format is json, jsonl or mcp; observation is
   *   supplied by the adapter.
   * @returns {Promise<Object>} Validated workerClaims
   */
  parseWorkerFinal(output, options = {}) {
    return this.parseWorkerOutput(output, options);
  }

  /**
   * #2915 (evidence contract): the attempt-terminal sibling of
   * `parseWorkerFinal`/`parseWorkerOutput` below. Shares the exact same
   * strict decoding AND the exact same per-CLI extraction every subclass's
   * own `parseWorkerFinal` override performs — the only difference is the
   * terminal assertion: `assertWorkerAttemptTerminal` requires the
   * launcher/adapter-owned `attemptOutcome` (never confirmed descendant
   * termination) instead of `assertWorkerTerminal`'s
   * `termination: 'confirmed'`. This lets a degraded-isolation shell
   * attempt or an MCP response — neither of which can ever produce a
   * confirmed descendant-stop — still validate a genuinely successful
   * attempt's final claims (session-launcher.mjs `captureOneWorker`). It
   * never manufactures confirmed termination: the caller's own
   * `termination`/`descendants` fields are untouched.
   *
   * Fixed once here, for every adapter, with NO per-adapter edit required
   * (2915 follow-up: the previous version called `parseWorkerOutput`
   * directly, skipping every subclass's own extraction override entirely).
   * The trick is calling `this.parseWorkerFinal` — polymorphic dispatch
   * picks up the ACTUAL (possibly overridden) method — with
   * `assertTerminal` folded into `options`. Every subclass override in this
   * directory follows the same shape: extract a CLI-specific final, then
   * `return super.parseWorkerFinal(extracted, { ...options, format: '...' })`
   * — the `...options` spread carries `assertTerminal` straight through to
   * the base `parseWorkerOutput` below, so the base class never needs
   * subclass-specific knowledge of each extraction. An adapter whose
   * override always throws regardless of input (Warp, Copilot:
   * `supportsAttemptVerification() === false`) throws here too, by the same
   * unconditional path — exactly the intended "never verifiable" behavior
   * for those two; `admitDirectWorker` treats such a CLI as `not-gated`
   * (recovery never consulted) rather than permanently blocking it.
   */
  parseWorkerAttemptFinal(output, options = {}) {
    return this.parseWorkerAttemptOutput(output, options);
  }

  async parseWorkerAttemptOutput(output, options = {}) {
    const { assertWorkerAttemptTerminal } = await importImpl(import.meta.url, 'mission-protocol/index.js');
    return this.parseWorkerFinal(output, { ...options, assertTerminal: assertWorkerAttemptTerminal });
  }

  /**
   * Capability signal (#2915 follow-up), default `true`: can this adapter's
   * `parseWorkerFinal`/`parseWorkerAttemptFinal` ever validate a genuine
   * final for ANY input, given a real completed attempt? Override `false`
   * only for an adapter whose `parseWorkerFinal` always throws regardless
   * of input (no observed output envelope exists to extract from yet —
   * Warp, Copilot). `admitDirectWorker` uses this to treat such a CLI as
   * never eligible for recovery-breaker gating, rather than admitting a
   * canary that can structurally never report success.
   */
  supportsAttemptVerification() { return true; }

  /** Strict group-mode path, shared by CLI and MCP. Never falls back to regex.
   * Drivers normalize qualified vendor event framing to result/message/terminal
   * JSONL, or supply one claims JSON document. Observation comes from the trusted
   * process/request owner, not from the final. This returns claims, not acceptance.
   * Called directly or through the `parseWorkerFinal()` alias; never through
   * `parseOutput()`, which keeps its own synchronous, non-group contract.
   * `options.assertTerminal`, when supplied (by `parseWorkerAttemptOutput`
   * above), replaces the default `assertWorkerTerminal` confirmed-termination
   * gate with the attempt-terminal one — every other step of decoding is
   * identical and unmodified.
   */
  async parseWorkerOutput(output, options = {}) {
    const {
      WORKER_MAX_JSON_BYTES, WORKER_MAX_NESTING_DEPTH, WorkerContractError,
      decodeWorkerProducedPayload, assertWorkerTerminal,
    } = await importImpl(import.meta.url, 'mission-protocol/index.js');
    const assertTerminal = options.assertTerminal ?? assertWorkerTerminal;
    const fail = message => { throw new WorkerContractError('OG_CONTRACT_INVALID', message); };
    const format = options.format ?? 'jsonl';
    const streamLimit = 10 * 1024 * 1024;
    const limit = options.maxOutputBytes ?? streamLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > streamLimit) fail('Invalid worker stream bound.');
    function boundedJson(value, bound) {
      // Check depth before serializing MCP objects supplied by a transport SDK.
      function visit(node, depth) {
        if (!node || typeof node !== 'object') return;
        if (depth > WORKER_MAX_NESTING_DEPTH) fail('Worker nesting depth exceeds 16.');
        for (const child of Object.values(node)) visit(child, depth + 1);
      }
      visit(value, 1);
      const bytes = JSON.stringify(value);
      if (bytes === undefined || Buffer.byteLength(bytes) > bound) fail('Worker final exceeds JSON byte bound.');
      return bytes;
    }
    function parse(bytes, bound) {
      if (typeof bytes !== 'string' && !(bytes instanceof Uint8Array)) fail('Worker output must be UTF-8 bytes or text.');
      // Encoding would silently replace lone surrogates with U+FFFD; reject.
      if (typeof bytes === 'string' && !bytes.isWellFormed()) fail('Malformed worker final JSON or UTF-8.');
      const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
      if (buffer.byteLength > bound) fail('Worker output exceeds byte bound.');
      let value;
      try {
        // ignoreBOM keeps a leading BOM in the text so the scanner rejects it
        // (RFC 8259 §8.1: a BOM must not be added).
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
        // Strict scanner, not JSON.parse: rejects duplicate object member
        // names (RFC 8259 §4) on every worker-final path instead of silently
        // keeping JSON.parse's "last value wins". See parseStrictWorkerJson.
        value = parseStrictWorkerJson(text, WORKER_MAX_NESTING_DEPTH);
      } catch (error) {
        if (error instanceof StrictJsonScanError && error.code === 'DEPTH') fail('Worker nesting depth exceeds 16.');
        if (error instanceof StrictJsonScanError && error.code === 'DUPLICATE') fail(`Duplicate worker JSON member name: ${error.message}`);
        fail('Malformed worker final JSON or UTF-8.');
      }
      return value;
    }
    let final;
    if (format === 'mcp') {
      const response = typeof output === 'string' || output instanceof Uint8Array ? parse(output, limit) : output;
      boundedJson(response, limit);
      if (!response || typeof response !== 'object' || Array.isArray(response)) fail('Malformed MCP worker result.');
      if (Object.keys(response).some(key => !['content', 'structuredContent', 'isError', '_meta'].includes(key))) fail('Unknown MCP result field.');
      const isError = response.isError;
      if (isError !== undefined && isError !== false) fail('MCP worker isError result.');
      const content = response.content;
      if (content !== undefined && (!Array.isArray(content) || content.length > 1)) fail('Missing or double MCP final.');
      let textFinal;
      if (content?.length) {
        const item = content[0];
        if (item?.type !== 'text' || typeof item.text !== 'string') fail('MCP final must be typed JSON text.');
        textFinal = parse(item.text, WORKER_MAX_JSON_BYTES);
      }
      final = response.structuredContent ?? textFinal;
      if (final === undefined) fail('Missing MCP worker final.');
      if (response.structuredContent !== undefined && textFinal !== undefined) {
        // MCP's required text mirror is not a second final, but must agree.
        const { isDeepStrictEqual } = await import('node:util');
        if (!isDeepStrictEqual(final, textFinal)) fail('Conflicting MCP final representations.');
      }
    } else if (format === 'json') {
      final = parse(output, Math.min(limit, WORKER_MAX_JSON_BYTES));
    } else if (format === 'jsonl') {
      if (typeof output !== 'string' && !(output instanceof Uint8Array)) fail('Worker stream must be UTF-8 bytes or text.');
      const bytes = typeof output === 'string' ? Buffer.from(output, 'utf8') : output;
      if (bytes.byteLength > limit) fail('Worker stream exceeds byte bound.');
      let stream;
      try { stream = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { fail('Malformed worker stream UTF-8.'); }
      // The `{"type":"terminal",...}` line is optional by design (05 §5,
      // 11 §B-OG-14: "qualified successful terminal event/exit" — either is
      // acceptable evidence, not both). It is in-band confirmation only.
      // The authoritative truncation backstop is `options.observation`
      // (adapter-owned process/transport exit), enforced unconditionally
      // below via `assertWorkerTerminal()` regardless of whether this line
      // was present. A stream cut immediately after the `result` line, with
      // no observed clean exit, still fails there — never on the missing
      // terminal line alone (#2890 MINOR 4).
      let terminal = false;
      for (const line of stream.split('\n')) {
        if (!line.trim()) continue;
        const event = parse(line, WORKER_MAX_JSON_BYTES);
        if (terminal || !event || typeof event !== 'object' || Array.isArray(event)) fail('Inconsistent worker terminal stream.');
        if (event.type === 'result') {
          if (final !== undefined) fail('Double worker final.');
          if (Object.keys(event).some(key => !['type', 'result'].includes(key)) || event.result === undefined) fail('Malformed worker result envelope.');
          final = event.result;
        } else if (event.type === 'message') {
          if (final !== undefined || typeof event.text !== 'string' || Object.keys(event).some(key => !['type', 'text'].includes(key))) fail('Inconsistent worker message stream.');
        } else if (event.type === 'terminal') {
          if (final === undefined || event.status !== 'completed' || Object.keys(event).some(key => !['type', 'status'].includes(key))) fail('Inconsistent worker terminal stream.');
          terminal = true;
        } else fail('Unknown or error worker stream event.');
      }
      if (final === undefined) fail('Missing worker final.');
    } else fail('Unknown worker final format.');
    boundedJson(final, WORKER_MAX_JSON_BYTES);
    const claims = decodeWorkerProducedPayload('workerClaims', 'worker', final);
    if (options.observation?.transport !== (format === 'mcp' ? 'mcp' : 'shell')) fail('Worker transport observation mismatch.');
    assertTerminal(options.observation);
    return claims;
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
   * Read token and spend accounting from one parsed stream event using this
   * provider's own event grammar.
   *
   * The base returns `null`: the launcher then applies its generic usage
   * logic (`SessionLauncher._extractUsageStats`) unchanged. An override
   * returns a {@link StreamUsage} for EVERY event, with zero counters and
   * `hasUsage: false` for events that carry no accounting, so a provider that
   * repeats one message's usage on several events can count it exactly once.
   * Overriding this hook also arms the launcher's live per-session spend cap
   * when the provider has no native budget control.
   *
   * @param {Object} event - One parsed JSON stream event
   * @returns {StreamUsage|null}
   */
  extractUsage(event) { return null; }

  /**
   * Whether this adapter overrides {@link extractUsage} with its own grammar.
   * @returns {boolean}
   */
  reportsStreamUsage() { return this.extractUsage !== ProviderAdapter.prototype.extractUsage; }

  /**
   * Categorize one parsed stream event as `tool_call`, `error`, `completion`
   * or another event type, using this provider's own event grammar.
   *
   * The base returns `null`: the launcher then applies its generic
   * categorization (`SessionLauncher._categorizeStreamEvent`) unchanged.
   *
   * @param {Object} event - One parsed JSON stream event
   * @returns {string|null}
   */
  categorizeEvent(event) { return null; }

  /**
   * Observe execution through the selected profile's framing and grammar.
   * This hook never parses or verifies worker claims: parseWorkerFinal remains
   * the separate strict final contract, and the conductor owns verification.
   */
  createHealthObserver(options = {}) {
    return createWorkerHealthObserver({
      ...options,
      provider: this.getName(),
      normalizeEvent: (event, source, binding) => this.observeHealthEvent(event, source, binding),
    });
  }

  /** Unknown provider grammar supplies no semantic execution evidence. */
  observeHealthEvent(event, source, binding) { return observeProviderHealthEvent(this.getName(), event, source, binding); }

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
