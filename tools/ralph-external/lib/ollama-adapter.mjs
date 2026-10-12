/**
 * Local text-only HTTP worker driver (roctinam/aiwg#2899, B-OG-09, B-OG-50 S1).
 *
 * Registers under the registry's generic, pre-reserved slot
 * `workerAdapters['local-http']` (schema `$defs/http` invocation kind,
 * `protocol: 'ollama'|'llama-cpp'|'openai-compatible'`) — see
 * `agentic/code/providers/model-capabilities.v1.json`'s `workerHealthAdapters.
 * local-http` descriptive placeholder, owned by this issue (B-OG-09). This
 * module is the Ollama backend of that slot; llama.cpp/openai-compatible
 * backends would share the same registry id with a different `protocol`.
 *
 * Shell client is `curl` against the Ollama HTTP API (`POST /api/generate`,
 * non-streaming), NOT the `ollama` CLI. Evidence for that choice (captured
 * on titan, ollama client/server 0.33.3,
 * .aiwg/working/s1-scratch/cli-help/ollama-titan.txt):
 *
 *   - `ollama run MODEL [PROMPT]` takes the prompt as a positional argv
 *     argument (captured `ollama run --help`, "Usage: ollama run MODEL
 *     [PROMPT]"); no piped-stdin prompt form is evidenced in the captured
 *     help, so the CLI form cannot satisfy this profile's "brief via stdin,
 *     never argv" invariant.
 *   - The CLI ships `pull` / `push` / `signin` subcommands (captured
 *     `ollama --help`), a broader network/registry surface than this
 *     text-only profile allows.
 *
 * `/api/generate` (not `/api/chat`) matches the registry's pre-seeded
 * `generatePath` schema field (there is no `chatPath` in `$defs/http`) and
 * fits a single-prompt, text-only, no-tools role more directly than a
 * multi-turn chat envelope. The exact response field set and the exact
 * `done_reason` value vocabulary (e.g. `"stop"`) are NOT independently
 * observed (no live call was made against the real, shared service —
 * forbidden by this task) and are treated as provisional.
 *
 * A local endpoint restricts the request DESTINATION; it does not prove
 * local inference. That assurance stays unqualified: nothing here observes
 * what the server does with the prompt.
 *
 * Request body (model, brief): owned by this module as a PURE function,
 * `buildOllamaGenerateBody`, per operator authorization on #2899 follow-up.
 * It is NOT yet wired into production stdin framing: the frozen
 * `src/serve/worker-stdin-frame.mjs` vocabulary (`stdin: 'closed' |
 * 'brief-text' | 'brief-json'`) has no adapter-pluggable envelope hook —
 * `'brief-json'` is hardcoded to OpenHuman's `{message, model_override, cwd}`
 * shape. The registry declares the closest existing fail-closed value,
 * `stdin: 'closed'`, with the `stdin` control `unqualified`, pointing at
 * roctinam/aiwg#2998 and #3002 (provider-supplied stdin frames / generated
 * artifacts). Until one of those lands, **dispatch through the real
 * conductor is blocked**: there is no production path that calls
 * `buildOllamaGenerateBody` and hands its output to this adapter's stdin.
 * Tests call the pure function directly to build the request body they feed
 * the fake server, which is accurate to what the adapter will do once wired,
 * not to what the stdin-closed registry entry can do today.
 *
 * `keep_alive` is never sent: the request body carries only
 * `{model, prompt, stream:false}`, so model residency is governed entirely
 * by the server's own defaults.
 *
 * Model digest binding ("changed model/runtime/template invalidates role"):
 * UNAVAILABLE at this layer. The frozen `invocation.selected` shape
 * (consumed by `buildWorkerArgs` across every adapter) carries only
 * `{model, effort}` — no digest field — so this adapter cannot bind a model
 * digest at argv-render time. `GET /api/tags` returns a `digest` per model
 * (read-only, evidenced on titan in the capture's models section) and the
 * registry's generic `WorkerModelObservation.provenance[].digest`
 * mechanism already exists for catalog-level staleness detection
 * (`src/models/model-discovery.ts`), but enforcing "changed digest
 * invalidates role" at dispatch time needs a qualification/health step
 * outside `buildWorkerArgs`, which is out of scope here.
 *
 * Installed-module shape: self-contained, with static `interfaceVersion` and
 * `register` exports for the #2885 loader, registering exactly the
 * `local-http` id (matching `workerAdapters.local-http.id` /
 * `runtimeDriver: 'installed:local-http'`). Documentation never qualifies
 * this profile: it stays `unqualified` until an authorized live run.
 */

import { ProviderAdapter } from './provider-adapter.mjs';
import { importImpl } from '../../_resolve-impl.mjs';

export const interfaceVersion = 1;

export const OLLAMA_SUPPORTED_VERSIONS = Object.freeze(['0.33.3']);
export const OLLAMA_GENERATE_PATH = '/api/generate';
/** Bounded, fixed transport timeout for a text-only one-shot call; not evidenced from the CLI (there is none), chosen defensively. */
export const OLLAMA_REQUEST_TIMEOUT_SECONDS = 300;
/** Bounded TCP connect phase, so a black-holed endpoint fails fast instead of burning the whole request timeout. */
export const OLLAMA_CONNECT_TIMEOUT_SECONDS = 10;
/** Bounded curl-side response size (`--max-filesize`); matches the registry invocation `maxOutputBytes` default (10 MiB). */
export const OLLAMA_MAX_RESPONSE_BYTES = 10485760;
/** Conservative bound on a model selector's length; Ollama names are short, this only excludes abuse. */
export const OLLAMA_MAX_MODEL_NAME_LENGTH = 128;
/** Brief bound, aligned with the shared brief bound: `WORKER_STDIN_FRAME_MAX_BRIEF_BYTES`
 * (`src/serve/worker-stdin-frame.mjs`), `readBrief` (`src/serve/worker-invocation.ts`),
 * `session-launcher.mjs` and `worker-invoke.mjs` all cap briefs at 256 KiB. */
export const OLLAMA_MAX_BRIEF_BYTES = 262144;
/** Only observed/documented terminal reason accepted as affirmative success; anything else (or absent on a `done:true` object) fails closed. */
const OLLAMA_SUCCESS_DONE_REASON = 'stop';

/** `host:port` validator: canonical dotted-decimal IPv4 loopback or RFC1918
 * private range only. Each octet must match `^(0|[1-9][0-9]{0,2})$` and be
 * <= 255, so leading-zero (octal-ambiguous) forms like `010.0.0.1` are
 * rejected along with hostnames, IPv6, integer/hex forms, userinfo and
 * anything else that is not canonical dotted-decimal. No Ollama cloud. */
export function assertLocalOllamaEndpoint(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Ollama worker requires an explicit local endpoint (OLLAMA_HOST); none was configured');
  }
  if (value.includes('\0') || /\s/.test(value)) {
    throw new Error('Ollama worker endpoint must not contain whitespace or control characters');
  }
  const match = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2}):(\d{1,5})$/.exec(value);
  if (!match) throw new Error('Ollama worker endpoint must be a canonical dotted-decimal IPv4 host:port (no hostnames, no cloud, no leading zeros)');
  const octets = match.slice(1, 5).map(Number);
  const port = Number(match[5]);
  if (octets.some(o => o > 255) || port === 0 || port > 65535) {
    throw new Error('Ollama worker endpoint is not a valid IPv4 host:port');
  }
  const [a, b] = octets;
  const isLoopback = a === 127;
  const isPrivate10 = a === 10;
  const isPrivate172 = a === 172 && b >= 16 && b <= 31; // covers the Docker bridge default, 172.17.0.0/16
  const isPrivate192 = a === 192 && b === 168;
  if (!(isLoopback || isPrivate10 || isPrivate172 || isPrivate192)) {
    throw new Error('Ollama worker endpoint must be loopback or an explicit private address; cloud/public hosts are refused');
  }
  return value;
}

/** One conservative model selector: letters, digits, `._-`, one optional
 * `:tag`, bounded length. Shared by `buildWorkerArgs` and
 * `buildOllamaGenerateBody` so both gates enforce the same rule. Rejects
 * `auto`/`default` in any case, any registry-style selector containing `/`,
 * anything ending in `-cloud`/`:cloud` (Ollama cloud selectors), and any
 * option-like, whitespace-bearing or control-character value. A local
 * endpoint plus a non-cloud name still does not prove local inference. */
const OLLAMA_MODEL_PATTERN = /^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/;
export function assertOllamaModelName(model) {
  if (typeof model !== 'string' || !model) {
    throw new Error('Ollama worker requires an explicit model name (never an inherited default)');
  }
  if (model.startsWith('-') || /[\s\u0000-\u001f\u007f-\u009f]/.test(model)) {
    throw new Error('Ollama worker model name must not be option-like and must not contain whitespace or control characters');
  }
  const lower = model.toLowerCase();
  const base = lower.split(':')[0];
  if (base === 'auto' || base === 'default') {
    throw new Error('Ollama worker refuses auto/default model selection; the model must be explicit');
  }
  if (model.includes('/')) {
    throw new Error('Ollama worker refuses registry-style model selectors containing "/"; use a plain local model name');
  }
  if (lower.endsWith('-cloud') || lower.endsWith(':cloud')) {
    throw new Error('Ollama worker refuses cloud model selectors; use a local model name');
  }
  if (model.length > OLLAMA_MAX_MODEL_NAME_LENGTH) {
    throw new Error(`Ollama worker model name exceeds ${OLLAMA_MAX_MODEL_NAME_LENGTH} characters`);
  }
  if (!OLLAMA_MODEL_PATTERN.test(model)) {
    throw new Error('Ollama worker requires a well-formed model name (letters, digits, ._- with one optional :tag)');
  }
  return model;
}

/** Pure request-body builder: `{model, prompt, stream:false}`, JSON-encoded,
 * no tools, no `keep_alive` (server residency defaults apply).
 * Not yet wired into production stdin framing (see module docstring, #2998/#3002). */
export function buildOllamaGenerateBody({ model, brief, role }) {
  assertOllamaModelName(model);
  if (role === 'coding') {
    throw new Error("Ollama worker is a text-only transport and refuses the 'coding' role");
  }
  if (typeof brief !== 'string' || !brief.trim() || brief.includes('\0')) {
    throw new Error('Ollama worker requires a non-empty text brief');
  }
  if (!brief.isWellFormed()) {
    throw new Error('Ollama worker brief must be well-formed UTF-8 text');
  }
  if (Buffer.byteLength(brief, 'utf8') > OLLAMA_MAX_BRIEF_BYTES) {
    throw new Error(`Ollama worker brief exceeds ${OLLAMA_MAX_BRIEF_BYTES} bytes (256 KiB, shared brief bound)`);
  }
  return JSON.stringify({ model, prompt: brief, stream: false });
}

/** Object-level rules for a non-streaming Ollama `/api/generate` response:
 * exactly one object, no error field, terminal `done:true` with the one
 * accepted `done_reason`, and affirmative non-empty `response` text. */
function parseOllamaGenerateResponseObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.error !== undefined) return null; // an error object anywhere in the stream fails, even alongside other fields
  if (value.done !== true) return null; // only a terminal object counts; streaming chunks are out of scope (stream:false)
  if (value.done_reason !== OLLAMA_SUCCESS_DONE_REASON) return null; // unobserved reasons fail closed (provisional vocabulary)
  if (typeof value.response !== 'string' || !value.response.trim()) return null; // affirmative, non-empty content required
  return value;
}

/** Strict, fail-closed parse of a single non-streaming Ollama `/api/generate` response object. Never a Promise, never throws. */
function parseOllamaGenerateResponse(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  return parseOllamaGenerateResponseObject(value);
}

class StrictOllamaEnvelopeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Duplicate-rejecting, depth-bounded strict JSON scan of a decoded envelope,
 * mirroring the shared `parseStrictWorkerJson` semantics in
 * `provider-adapter.mjs` (which is not exported for reuse): member names are
 * compared only after full escape decoding, every object level is tracked
 * independently, nesting past `maxDepth` fails fast, and trailing data after
 * the single top-level value fails. Returns the parsed value. */
function parseStrictOllamaEnvelopeJson(text, maxDepth) {
  const length = text.length;
  let index = 0;
  const fail = (code, message) => { throw new StrictOllamaEnvelopeError(code, `${message} (offset ${index})`); };
  const skipWhitespace = () => {
    while (index < length) {
      const code = text.charCodeAt(index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) index += 1;
      else break;
    }
  };
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
    if (depth > maxDepth) fail('DEPTH', 'Ollama envelope nesting depth exceeds bound');
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
    if (depth > maxDepth) fail('DEPTH', 'Ollama envelope nesting depth exceeds bound');
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

/** Strictly validate the ORIGINAL envelope bytes before any extraction:
 * fatal UTF-8 decode (no silent U+FFFD replacement), byte bound honoured
 * against `maxOutputBytes` (mirroring the shared hook: at most
 * `WORKER_MAX_JSON_BYTES`, tightened by an explicit `maxOutputBytes`),
 * no duplicate keys, bounded depth, exactly one top-level object.
 * Returns the parsed envelope object; throws on any violation. */
async function parseStrictOllamaEnvelope(output, maxOutputBytes) {
  let bytes;
  if (typeof output === 'string') {
    if (!output.isWellFormed()) throw new Error('Ollama worker envelope is not well-formed UTF-8');
    bytes = Buffer.from(output, 'utf8');
  } else if (output instanceof Uint8Array) {
    bytes = Buffer.from(output.buffer, output.byteOffset, output.byteLength);
  } else {
    throw new Error('Ollama worker final must be UTF-8 bytes or text');
  }
  const { WORKER_MAX_JSON_BYTES, WORKER_MAX_NESTING_DEPTH } =
    await importImpl(import.meta.url, 'mission-protocol/index.js');
  const streamLimit = 10 * 1024 * 1024;
  const limit = maxOutputBytes ?? streamLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > streamLimit) {
    throw new Error('Invalid worker stream bound.');
  }
  const bound = Math.min(limit, WORKER_MAX_JSON_BYTES);
  if (bytes.byteLength > bound) throw new Error('Ollama worker envelope exceeds byte bound');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Ollama worker envelope is not valid UTF-8');
  }
  let value;
  try {
    value = parseStrictOllamaEnvelopeJson(text, WORKER_MAX_NESTING_DEPTH);
  } catch (error) {
    if (error instanceof StrictOllamaEnvelopeError && error.code === 'DEPTH') {
      throw new Error('Ollama worker envelope nesting depth exceeds bound');
    }
    if (error instanceof StrictOllamaEnvelopeError && error.code === 'DUPLICATE') {
      throw new Error(`Ollama worker envelope has duplicate member name: ${error.message}`);
    }
    throw new Error('Ollama worker envelope is malformed JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Ollama worker envelope must be exactly one JSON object');
  }
  return value;
}

export class OllamaAdapter extends ProviderAdapter {
  getBinary() { return 'curl'; }
  getName() { return 'local-http'; }
  getCapabilities() {
    return { streamJson: false, sessionResume: false, budgetControl: false, systemPrompt: false,
      agentMode: false, mcpConfig: false, maxTurns: false, rpcAbort: false };
  }
  buildSessionArgs() {
    throw new Error('Ollama has no qualified Ralph loop session; use the direct worker profile');
  }
  buildAnalysisArgs() { return this.buildSessionArgs(); }

  /** Driver-owned argv after the binary: no brief text (text travels on
   * stdin only, once #2998/#3002 land — see module docstring), no explicit
   * effort, an explicit validated model and local-only endpoint, and a
   * text-only transport that refuses the coding role. There is no
   * tool-calling surface implemented anywhere in this adapter. Curl is
   * hardened against ambient configuration: `-q` first (no curlrc),
   * `--max-redirs 0` (`curl --help all` lists no `--no-location` flag, so
   * the explicit redirect cap is used instead), `--proto =http` (HTTP only),
   * `--noproxy '*'` (proxy environment is never consulted),
   * `--connect-timeout` and `--max-time` bounds, and `--max-filesize`
   * bounding the response. The request body travels on stdin via
   * `--data-binary @-`, never argv. */
  buildWorkerArgs(invocation, _profile, _permissions) {
    if (invocation?.role === 'coding') {
      throw new Error("Ollama worker is a text-only transport and refuses the 'coding' role");
    }
    const effort = invocation?.selected?.effort?.value ?? null;
    if (effort !== null) throw new Error('Ollama worker has no evidenced effort control; effort must be null/not-applicable');
    const model = invocation?.selected?.model;
    assertOllamaModelName(model);
    const cwd = invocation?.cwd;
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) {
      throw new Error('Ollama worker requires an absolute workspace');
    }
    const endpoint = assertLocalOllamaEndpoint(process.env.OLLAMA_HOST);
    const url = `http://${endpoint}${OLLAMA_GENERATE_PATH}`;
    return ['-q', '-sS', '--max-redirs', '0', '--proto', '=http', '--noproxy', '*',
      '--connect-timeout', String(OLLAMA_CONNECT_TIMEOUT_SECONDS),
      '--max-time', String(OLLAMA_REQUEST_TIMEOUT_SECONDS),
      '--max-filesize', String(OLLAMA_MAX_RESPONSE_BYTES),
      '--fail-with-body', '-H', 'Content-Type: application/json', '-X', 'POST', url, '--data-binary', '@-'];
  }

  /** No streaming event grammar is implemented (stream:false is explicit): final-only. */
  observeHealthEvent() { return null; }

  /** Strict, fail-closed sync extraction for the installed driver's `extractFinal` hook. */
  parseOutput(stdout) {
    return parseOllamaGenerateResponse(stdout);
  }

  /** The claims hook (#2890): the ORIGINAL envelope bytes are strictly
   * validated first (fatal UTF-8, byte bound against `maxOutputBytes`, no
   * duplicate keys, bounded depth, exactly one object); then the existing
   * done/done_reason/response rules apply; then the model's own answer text
   * — the worker's claims document, exactly like the Claude/Hermes direct
   * profiles — is reparsed through the shared strict parser. MCP envelopes
   * keep the shared strict parser directly. */
  async parseWorkerFinal(output, options = {}) {
    if (options.format === 'mcp') return super.parseWorkerFinal(output, options);
    const envelope = await parseStrictOllamaEnvelope(output, options.maxOutputBytes);
    const response = parseOllamaGenerateResponseObject(envelope);
    if (!response) throw new Error('Ollama worker final is missing, malformed, or not an affirmative success');
    return super.parseWorkerFinal(response.response, { ...options, format: 'json' });
  }

  /** No abort/cancel channel is evidenced for a one-shot HTTP call; owned process control (SIGTERM/SIGKILL) remains the only stop path. */
  getAbortInput() { return null; }
}

/** Installed-module registration: exactly the one approved adapter ID (the registry's `local-http` slot). */
export function register(factory) {
  factory('local-http', () => new OllamaAdapter());
}

export default OllamaAdapter;
