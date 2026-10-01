/**
 * Embedded source of the isolated provider driver (gates P1, round 3).
 *
 * The parent (`loader.ts`) passes this verbatim to `node -e` inside a
 * bubblewrap sandbox (see `isolationLaunchPlan`). Nothing is written to disk
 * and the child reads no files: the request (provider module sources, frozen
 * clock, seed, records) and a per-run random nonce arrive on stdin, which the
 * driver consumes completely BEFORE any provider code is compiled.
 *
 * The driver is plain dependency-free JavaScript held in a `String.raw`
 * template, so it must contain no backtick and no dollar-brace sequence
 * (the scanner builds the backtick from its char code). Edit with care: the
 * bytes below are exactly the bytes the child runs.
 *
 * Security model (see docs/decision/gate-providers.md): the `vm` context is
 * NOT the boundary. The boundary is the OS sandbox (bubblewrap: no network,
 * no host filesystem beyond the node binary and its libraries, empty
 * environment, private pid/ipc/uts/user/mount namespaces) plus the parent's
 * SIGKILL timeout, output cap and nonce-framed result channel. Inside, node
 * runs with `--permission` (no fs, no child processes, no workers) and
 * `--disallow-code-generation-from-strings`. The `vm` context is depth:
 *
 * - created with `codeGeneration: { strings: false, wasm: false }`, so no
 *   intrinsic `Function`/`eval` constructor can compile code;
 * - every intrinsic reachable from the context global is frozen before
 *   provider code runs, so host-side awaits of context promises and stack
 *   hooks cannot be hijacked;
 * - host -> context traffic is primitives only: the provider is driven by
 *   context-realm functions created by the bootstrap, results leave as a
 *   JSON string the host polls for, and the dynamic-import trap throws a
 *   context-realm Error. No host object or function ever reaches provider
 *   code.
 */
export const ISOLATED_CHILD_SOURCE = String.raw`
import fs from 'node:fs';
import vm from 'node:vm';

var MAX_RESPONSE_BYTES = 1048576;
var FRAME = 'AIWG-RESULT ';
var BACKTICK = String.fromCharCode(96);
var nonce = null;
var responded = false;
var api = null;

function respond(body) {
  if (responded) return;
  responded = true;
  var text;
  try { text = JSON.stringify(body); } catch (e) { text = undefined; }
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    text = JSON.stringify({ ok: false, error: 'isolated provider response exceeds the output cap' });
  }
  if (nonce === null) process.exit(70);
  process.stdout.write(FRAME + nonce + ' ' + text + '\n', function () { process.exit(0); });
}
function refuse(message) { respond({ ok: false, error: String(message).slice(0, 2000) }); }
function describe(error) {
  if (typeof error === 'string') return error;
  // Host-realm errors (driver/Node) are read here; anything else came from
  // the context and is described by the context's own trusted function.
  if (error instanceof Error) return String(error.message);
  if (api !== null) {
    try { var text = api.describe(error); if (typeof text === 'string') return text; } catch (e) { /* fall through */ }
  }
  return 'unknown';
}
process.on('uncaughtException', function (error) { refuse('isolated provider crashed: ' + describe(error)); });
process.on('unhandledRejection', function (error) { refuse('isolated provider crashed: ' + describe(error)); });

function readRequest() {
  var raw = fs.readFileSync(0, 'utf8');
  var newline = raw.indexOf('\n');
  var candidate = newline === -1 ? '' : raw.slice(0, newline);
  if (/^[0-9a-f]{64}$/.test(candidate) !== true) process.exit(71);
  nonce = candidate;
  var request = JSON.parse(raw.slice(newline + 1));
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('isolated provider request is invalid');
  return request;
}

// Runs INSIDE the vm context (compiled there from this function's source).
// Captures the intrinsics it needs, strips I/O, clock and randomness, freezes
// every reachable intrinsic and returns frozen context-realm entry points.
function contextBootstrap(seed, clockMs, recordsJson) {
  'use strict';
  var G = globalThis;
  var R = Reflect;
  var apply = R.apply;
  var construct = R.construct;
  var ownKeys = R.ownKeys;
  var getProto = Object.getPrototypeOf;
  var getDesc = Object.getOwnPropertyDescriptor;
  var defineProperty = Object.defineProperty;
  var freeze = Object.freeze;
  var isArray = Array.isArray;
  var keysOf = Object.keys;
  var PromiseCtor = Promise;
  var promiseResolve = Promise.resolve;
  var promiseThen = Promise.prototype.then;
  var stringify = JSON.stringify;
  var parse = JSON.parse;
  var ErrorCtor = Error;
  var StringCtor = String;
  var isSafeInteger = Number.isSafeInteger;
  var OriginalDate = Date;
  var dateParse = Date.parse;
  var dateUTC = Date.UTC;

  if (typeof clockMs !== 'number' || !isSafeInteger(clockMs)) throw new ErrorCtor('isolated clock is invalid');

  // Intrinsics not reachable by name from the global object.
  var hidden = [
    function () {}, async function () {}, function* () {}, async function* () {},
    (function* () {})(), (async function* () {})(),
    [][Symbol.iterator](), new Map().entries(), new Set().values(), ''[Symbol.iterator](),
    /x/[Symbol.matchAll](''), getProto(Int8Array), Promise.resolve(),
    (function () { return arguments; })(),
  ];
  try { hidden.push([].values().map(function (x) { return x; })); } catch (e) { /* no iterator helpers */ }
  try { hidden.push(G.Iterator.from({ next: function () { return { done: true }; } })); } catch (e) { /* none */ }

  var FORBIDDEN = ['eval', 'Function', 'WebAssembly', 'Proxy', 'Reflect', 'console', 'Intl', 'Atomics',
    'SharedArrayBuffer', 'FinalizationRegistry', 'WeakRef', 'AsyncDisposableStack', 'DisposableStack',
    'SuppressedError', 'Iterator'];
  for (var i = 0; i < FORBIDDEN.length; i++) {
    var name = FORBIDDEN[i];
    try { delete G[name]; } catch (e) { /* checked below */ }
    if (typeof G[name] !== 'undefined') { try { G[name] = undefined; } catch (e) { /* checked below */ } }
    if (typeof G[name] !== 'undefined') throw new ErrorCtor('isolated context retains ' + name);
  }
  try { delete Math.random; } catch (e) { /* checked below */ }
  if (typeof Math.random !== 'undefined') throw new ErrorCtor('isolated context retains Math.random');

  // Frozen clock: the real Date constructor becomes unreachable (no
  // prototype link from the shim, prototype.constructor repointed).
  var FROZEN_MS = clockMs;
  var FrozenDate = function Date() {
    if (new.target === undefined) return apply(OriginalDate.prototype.toString, construct(OriginalDate, [FROZEN_MS]), []);
    var args = [];
    for (var a = 0; a < arguments.length; a++) args.push(arguments[a]);
    return construct(OriginalDate, args.length === 0 ? [FROZEN_MS] : args, new.target);
  };
  FrozenDate.prototype = OriginalDate.prototype;
  defineProperty(OriginalDate.prototype, 'constructor', { value: FrozenDate, writable: false, enumerable: false, configurable: false });
  FrozenDate.now = function now() { return FROZEN_MS; };
  FrozenDate.parse = dateParse;
  FrozenDate.UTC = dateUTC;
  G.Date = FrozenDate;
  G.clock = FROZEN_MS;

  var state = (seed >>> 0) || 1;
  G.random = function random() {
    state = (state + 0x6D2B79F5) >>> 0;
    var t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  var freezeDeep = function (value) {
    if (value && typeof value === 'object') {
      var keys = keysOf(value);
      for (var k = 0; k < keys.length; k++) freezeDeep(value[keys[k]]);
      freeze(value);
    }
    return value;
  };
  var records = typeof recordsJson === 'string' ? freezeDeep(parse(recordsJson)) : undefined;

  // Harden: freeze every object reachable from the global object and the
  // hidden intrinsics (values, accessors and prototype chains). The global
  // object itself stays extensible for provider top-level state.
  var seen = new Set();
  var stack = [G, OriginalDate].concat(hidden);
  while (stack.length > 0) {
    var current = stack.pop();
    if ((typeof current !== 'object' && typeof current !== 'function') || current === null || seen.has(current)) continue;
    seen.add(current);
    stack.push(getProto(current));
    var own = ownKeys(current);
    for (var o = 0; o < own.length; o++) {
      var desc = getDesc(current, own[o]);
      if (desc === undefined) continue;
      if ('value' in desc) stack.push(desc.value);
      if (desc.get) stack.push(desc.get);
      if (desc.set) stack.push(desc.set);
    }
  }
  seen.forEach(function (value) { if (value !== G) freeze(value); });

  var result;
  var finish = function (body) {
    var text;
    try { text = stringify(body); } catch (e) { text = undefined; }
    if (typeof text !== 'string') text = stringify({ ok: false, error: 'provider result is not JSON-serializable' });
    if (result === undefined) result = text;
  };
  var describeError = function (error) {
    try {
      if (typeof error === 'string') return error;
      var message = error && error.message;
      if (typeof message === 'string') return message;
      return StringCtor(error);
    } catch (e) {
      return 'unknown';
    }
  };
  var fail = function (error) { finish({ ok: false, error: describeError(error) }); };

  var run = function (ns, mode, expectedId, expectedVersion) {
    try {
      var descriptor = (ns && ns.provider) || (ns && ns.default);
      if (!descriptor || typeof descriptor !== 'object') throw new ErrorCtor('provider module has no provider export');
      if (descriptor.id !== expectedId || descriptor.version !== expectedVersion) {
        throw new ErrorCtor('provider module identity does not match its manifest declaration');
      }
      if (typeof descriptor.description !== 'string' || !descriptor.description) throw new ErrorCtor('provider description is invalid');
      var metrics = descriptor.metrics;
      if (!metrics || typeof metrics !== 'object' || isArray(metrics)) throw new ErrorCtor('provider metrics declaration is invalid');
      if (mode === 'inspect') {
        finish({ ok: true, descriptor: {
          id: descriptor.id, version: descriptor.version, description: descriptor.description, metrics: metrics,
        } });
        return;
      }
      if (typeof descriptor.compute !== 'function') throw new ErrorCtor('provider compute is not a function');
      var raw = descriptor.compute(records);
      var settled = apply(promiseResolve, PromiseCtor, [raw]);
      apply(promiseThen, settled, [function (value) {
        try {
          if (!value || typeof value !== 'object' || isArray(value)) throw new ErrorCtor('provider returned no metrics');
          if (!value.metrics || typeof value.metrics !== 'object') throw new ErrorCtor('provider returned no metrics');
          finish({ ok: true, result: value });
        } catch (e) {
          fail(e);
        }
      }, fail]);
    } catch (e) {
      fail(e);
    }
  };

  return freeze({
    run: run,
    poll: function () { return result; },
    describe: describeError,
    makeError: function (message) { return new ErrorCtor(StringCtor(message)); },
  });
}

function stripModule(code, rel) {
  var failScan = function (why) { throw new Error('provider module cannot be scanned: ' + rel + ': ' + why); };
  var n = code.length;
  var kept = [];
  var pos = 0;
  var push = function (ch) { kept.push(ch); };
  var skipLine = function () { while (pos < n && code[pos] !== '\n') { push(' '); pos++; } };
  var skipBlock = function () {
    push(' '); push(' '); pos += 2;
    var closed = false;
    while (pos < n) {
      if (code[pos] === '*' && code[pos + 1] === '/') { push(' '); push(' '); pos += 2; closed = true; break; }
      push(code[pos] === '\n' ? '\n' : ' '); pos++;
    }
    if (closed !== true) failScan('unterminated block comment');
  };
  var skipString = function (quote) {
    push(' '); pos++;
    var done = false;
    while (pos < n) {
      var c = code[pos];
      if (c === '\\') { push(' '); push(' '); pos += 2; continue; }
      if (c === '\n') failScan('unterminated string literal');
      if (c === quote) { push(' '); pos++; done = true; break; }
      push(' '); pos++;
    }
    if (done !== true) failScan('unterminated string literal');
  };
  var skipTemplate;
  var scanBrace = function () {
    var depth = 1;
    while (pos < n && depth > 0) {
      var c = code[pos];
      if (c === '{') { push(c); depth++; pos++; continue; }
      if (c === '}') { depth--; push(depth === 0 ? ' ' : c); pos++; continue; }
      if (c === '/' && code[pos + 1] === '/') { skipLine(); continue; }
      if (c === '/' && code[pos + 1] === '*') { skipBlock(); continue; }
      if (c === "'" || c === '"') { skipString(c); continue; }
      if (c === BACKTICK) { skipTemplate(); continue; }
      push(c); pos++;
    }
    if (depth !== 0) failScan('unterminated substitution');
  };
  skipTemplate = function () {
    push(' '); pos++;
    while (pos < n) {
      var c = code[pos];
      if (c === '\\') { push(' '); push(' '); pos += 2; continue; }
      if (c === BACKTICK) { push(' '); pos++; return; }
      if (c === '$' && code[pos + 1] === '{') { push(' '); push(' '); pos += 2; scanBrace(); continue; }
      push(c === '\n' ? '\n' : ' '); pos++;
    }
    failScan('unterminated template literal');
  };
  if (code.slice(0, 2) === '#!') { while (pos < n && code[pos] !== '\n') { push(' '); pos++; } }
  while (pos < n) {
    var ch = code[pos];
    if (ch === '/' && code[pos + 1] === '/') { skipLine(); continue; }
    if (ch === '/' && code[pos + 1] === '*') { skipBlock(); continue; }
    if (ch === "'" || ch === '"') { skipString(ch); continue; }
    if (ch === BACKTICK) { skipTemplate(); continue; }
    push(ch); pos++;
  }
  return kept.join('');
}

function forbidDynamic(cleaned, rel) {
  var pattern = /(^|[^.$\w])(import|require)(\s*)(\(|\.)?/g;
  var match = null;
  while ((match = pattern.exec(cleaned)) !== null) {
    var keyword = match[2];
    var punct = match[4];
    if (keyword === 'import' && punct === '(') throw new Error('dynamic import() is forbidden in ' + rel + ': use static relative imports');
    if (keyword === 'require' && punct === '(') throw new Error('require() is forbidden in ' + rel + ': use static relative imports');
  }
}

async function main() {
  var request = readRequest();
  var entry = request.entry;
  var sources = request.modules;
  var mode = request.mode;
  if (typeof entry !== 'string' || !entry || !sources || typeof sources !== 'object' || Array.isArray(sources)) {
    throw new Error('isolated provider request is invalid');
  }
  if (mode !== 'inspect' && mode !== 'invoke') throw new Error('isolated provider request is invalid');
  if (typeof request.clockMs !== 'number' || !Number.isSafeInteger(request.clockMs)) throw new Error('isolated clock is invalid');
  if (typeof request.seed !== 'number' || !Number.isSafeInteger(request.seed) || request.seed < 0) throw new Error('isolated seed is invalid');
  if (mode === 'invoke' && typeof request.recordsJson !== 'string') throw new Error('isolated provider records are invalid');
  if (typeof request.expectedId !== 'string' || !request.expectedId
    || typeof request.expectedVersion !== 'string' || !request.expectedVersion) {
    throw new Error('isolated provider request is invalid');
  }
  var modules = new Map();
  var names = Object.keys(sources).sort();
  for (var s = 0; s < names.length; s++) {
    if (typeof sources[names[s]] !== 'string') throw new Error('isolated provider request is invalid');
    modules.set(names[s], sources[names[s]]);
  }

  var context = vm.createContext(Object.create(null), {
    name: 'aiwg-gate-provider',
    codeGeneration: { strings: false, wasm: false },
  });
  try {
    var setup = vm.runInContext('(' + contextBootstrap.toString() + ')', context, { filename: '__aiwg_bootstrap.js' });
    api = setup(request.seed >>> 0, request.clockMs, mode === 'invoke' ? request.recordsJson : undefined);
  } catch (e) {
    throw new Error('isolated context setup failed: ' + ((e && e.message) || 'unknown'));
  }
  var runInContext = api.run;
  var pollContext = api.poll;
  var makeContextError = api.makeError;

  var cache = new Map();
  function childLink(specifier, parentRel) {
    if (typeof specifier !== 'string' || (specifier.startsWith('./') !== true && specifier.startsWith('../') !== true)) {
      throw new Error('bare and external imports are forbidden in phase 1: ' + specifier);
    }
    var base = parentRel ? parentRel.slice(0, parentRel.lastIndexOf('/') + 1) : '';
    var parts = (base + specifier).split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '' || parts[i] === '.') continue;
      if (parts[i] === '..') {
        if (out.length === 0) throw new Error('provider import escapes the snapshot: ' + specifier);
        out.pop();
      } else out.push(parts[i]);
    }
    var rel = out.join('/');
    if (rel.endsWith('.mjs') !== true) throw new Error('provider modules must be relative .mjs files: ' + specifier);
    if (rel.indexOf('__aiwg_') === 0 || rel.indexOf('/__aiwg_') !== -1) throw new Error('provider module is reserved: ' + specifier);
    if (modules.has(rel) !== true) throw new Error('provider module is not in the pinned snapshot: ' + specifier);
    return rel;
  }
  // The dynamic-import trap answers with a CONTEXT-realm Error: a host Error
  // would hand provider code the host Function constructor.
  function denyDynamicImport() {
    throw makeContextError('dynamic import() is forbidden: use static relative imports');
  }
  async function getModule(rel) {
    if (cache.has(rel)) return cache.get(rel);
    var mod = new vm.SourceTextModule(modules.get(rel), {
      identifier: rel,
      context: context,
      importModuleDynamically: denyDynamicImport,
    });
    cache.set(rel, mod);
    try {
      await mod.link(async function (specifier) { return getModule(childLink(specifier, rel)); });
    } catch (e) {
      throw new Error('provider import failed for ' + rel + ': ' + ((e && e.message) || 'unknown'));
    }
    return mod;
  }

  modules.forEach(function (source, rel) {
    if (rel.endsWith('.mjs') !== true) return;
    try {
      new vm.SourceTextModule(source, { identifier: rel, context: context, importModuleDynamically: denyDynamicImport });
    } catch (e) {
      throw new Error('provider module does not parse: ' + rel + ': ' + describe(e));
    }
    forbidDynamic(stripModule(source, rel), rel);
  });
  var entryMod = await getModule(childLink('./' + entry, ''));
  try {
    await entryMod.evaluate();
  } catch (e) {
    throw new Error('provider module threw during evaluation: ' + describe(e));
  }
  runInContext(entryMod.namespace, mode, request.expectedId, request.expectedVersion);
  var text = await new Promise(function (resolve) {
    var polls = 0;
    var tick = function () {
      var value = pollContext();
      if (typeof value === 'string') { resolve(value); return; }
      polls++;
      if (polls < 64) setImmediate(tick); else setTimeout(tick, 2);
    };
    setImmediate(tick);
  });
  var body = JSON.parse(text);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('isolated provider produced no result');
  return body;
}

main().then(
  function (body) {
    if (body.ok === true) respond(body);
    else refuse(typeof body.error === 'string' && body.error ? body.error : 'isolated provider failed');
  },
  function (error) { refuse(describe(error)); },
);
`;
