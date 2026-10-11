/**
 * OpenClaw (`openclaw`) direct-worker driver (roctinam/aiwg#2907).
 *
 * Version-bound to `openclaw` 2026.10.1 (e178c39), evidenced from an
 * installed binary's `--help`/`agent exec --help` (grade H) plus the
 * installed npm package's own bundled source for the two behaviours no
 * flag documents (grade R; read on noodle 2026-10-10,
 * `dist/agent-exec-4ENgJefG.mjs` + `dist/agent-exec-input-C7lx24Ak.mjs`):
 *
 *   openclaw agent exec --isolated --auth-env-only --json \
 *     --model <provider/model> --thinking <level> --cwd <workspace> \
 *     --message-file <briefPath>
 *
 * `agent exec` ("Run one isolated headless embedded agent turn") is the
 * no-gateway, no-channel entrypoint distinct from `openclaw agent`, which
 * routes through the Gateway and can `--deliver` a reply to a chat channel
 * -- never emitted here. The brief travels only as a file path
 * (`--message-file <path>`, source: `resolveAgentExecPrompt` reads the file
 * to EOF); it never appears on argv as text, and no `--fallback` is ever
 * emitted (none is implicit, and the help text requires `--fallback` to
 * repeat with an explicit `--model` already present -- this adapter simply
 * never passes it).
 *
 * `--isolated` ignores the ambient config entirely (`resolveExecBaseConfig`
 * returns `{}` plus implicit roster defaults) and skips plugin/MCP install
 * roots outright (`pluginInstallContext` is never loaded when
 * `opts.isolated === true`) -- this is the disabling control the no-auto-
 * approval invariant asks for; there is no separate approval/sandbox flag
 * on `agent exec --help` to refuse instead. `--auth-env-only` forces
 * `withEnvOnlyAuthProfileStore`, so credentials resolve only from
 * environment variables, never stored or external CLI logins.
 *
 * Source-confirmed (not flag-controlled): an isolated `agent exec` run
 * merges `buildExecConfigDefaults()` under the (empty, isolated) base --
 * `agents.defaults.sandbox.mode: "off"`, `tools.exec.mode: "full"`,
 * `tools.fs.workspaceOnly: true`, `env.shellEnv.enabled: false`. Only the
 * file tools are limited to `--cwd`; commands run with full execution and no
 * CLI sandbox, so the run is NOT confined to the workspace. It never imports
 * the parent shell environment. No sandbox flag exists to request
 * confinement, so an external boundary is required. This is reported
 * honestly as `sandbox: unavailable`, not invented.
 *
 * `--json` prints exactly one envelope object on stdout after the run
 * settles (`writeAgentExecOutput` -> `writeRuntimeJson`, called once):
 * `{ ok, status: "ok"|"error"|"timeout", final, payloads, model, provider,
 * sessionId, error? }`. There is no JSONL event stream and no `-o`/output-
 * file flag, so there is nothing to observe mid-run (`outputFraming:
 * "final-json"`, `progressEvidence: []`, matching the pre-existing #2896
 * health stub for this provider). Exit code mirrors `status` exactly
 * (`ok` -> 0, `timeout` -> 2, anything else -> 1), but `parseOutput()`
 * below still checks `ok`/`status`/non-empty `final` itself rather than
 * trusting the exit code alone.
 *
 * `--thinking` accepts `off|minimal|low|medium|high|xhigh|adaptive|max|
 * ultra` (`agent exec --help`). `adaptive` lets OpenClaw pick the level
 * itself per turn -- the same "let the tool choose" shape this profile
 * refuses for model/provider -- so it is excluded from
 * {@link OPENCLAW_DIRECT_THINKING_LEVELS} and never emitted.
 *
 * Installed-module shape: static `interfaceVersion` and `register` exports
 * so the #2885 installed loader can approve this file by digest under
 * `installed:openclaw` (mirroring #2911 openhuman-adapter.mjs). This is not
 * a Ralph-loop session provider.
 *
 * Fix round 1 (#2907): the conductor's live smoke run on openclaw 2026.10.1
 * confirmed the `--json` envelope live (pretty-printed, multi-line,
 * `ok:true`/`status:"ok"`/`final:"openclaw-smoke-ok"`), and the appended
 * `agent exec --help` capture is cited as H-grade evidence throughout. Two
 * contract fixes land here:
 *   1. `parseOutput()` (the candidate extractor the installed driver's
 *      extraction hook treats as "a final was produced" for anything
 *      non-null) now returns `null` for every unsuccessful envelope
 *      (`ok:false`, any non-`"ok"` status, or an empty/whitespace `final`),
 *      never a `{ ..., settled: false }` object — the hook has no concept
 *      of `settled` and would have accepted the object itself.
 *   2. `parseWorkerFinal()` is added (this adapter extended
 *      `ProviderAdapter` only implicitly before; it now does so to use
 *      `super.parseWorkerFinal`). It is the strict, production gate wired
 *      by `tools/ralph-external/session-launcher.mjs` (~480-490) through
 *      `extractFinal`/`finalValid`: it re-validates the same envelope
 *      strictly, then hands only the model's own `final` text to the
 *      shared strict `workerClaims` parser (`format: 'json'`), mirroring
 *      `hermes-adapter.mjs:356` and `claude-adapter.mjs:344`. An unsuccessful
 *      envelope throws instead of silently returning a candidate.
 */

import { ProviderAdapter } from './provider-adapter.mjs';

export const interfaceVersion = 1;

export const OPENCLAW_SUPPORTED_VERSIONS = Object.freeze(['2026.10.1']);

/** `agent exec --help`, 2026.10.1: "Thinking level: off | minimal | low |
 * medium | high | xhigh | adaptive | max | ultra where supported".
 * `adaptive` is excluded: it is OpenClaw choosing the level itself, not an
 * explicit resolved value (see module doc). */
export const OPENCLAW_DIRECT_THINKING_LEVELS = Object.freeze([
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]);

/** Case-insensitive "let the tool pick" sentinels refused for model/provider. */
const AUTO_SELECTION_VALUES = Object.freeze(['auto', 'default']);

function requireOptionSafeString(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error(`OpenClaw worker requires ${label}`);
  if (value.startsWith('-') || /[\s\u0000-\u001f]/.test(value)) {
    throw new Error(`OpenClaw worker ${label} cannot look like an option: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Strict envelope validation shared by `parseOutput` and `parseWorkerFinal`.
 * Returns the parsed envelope only when it is a well-formed, self-consistent
 * success; `null` for malformed JSON, trailing content, a non-object value,
 * a disagreeing `ok`/`status` pair, any non-`"ok"` status, or an empty/
 * whitespace `final`. There is deliberately no partial-success shape: a
 * caller that treats anything other than this return value as a final is
 * wrong, since `ok:false`/`timeout` envelopes must never be candidates. */
function parseSuccessfulEnvelope(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  let envelope;
  try { envelope = JSON.parse(stdout); } catch { return null; }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  if (typeof envelope.ok !== 'boolean' || typeof envelope.status !== 'string') return null;
  if (!['ok', 'error', 'timeout'].includes(envelope.status)) return null;
  if (envelope.ok !== (envelope.status === 'ok')) return null;
  if (envelope.ok !== true) return null;
  if (typeof envelope.final !== 'string' || !envelope.final.trim()) return null;
  return envelope;
}

export class OpenClawAdapter extends ProviderAdapter {
  getBinary() { return 'openclaw'; }
  getName() { return 'openclaw'; }
  getCapabilities() {
    return { streamJson: false, sessionResume: false, budgetControl: false, systemPrompt: false,
      agentMode: false, mcpConfig: false, maxTurns: false };
  }

  buildSessionArgs() {
    throw new Error('OpenClaw has no qualified Ralph loop session; use the direct worker profile');
  }
  buildAnalysisArgs() { return this.buildSessionArgs(); }

  /** Driver-owned argv after the binary: no brief text, no `--deliver`/
   * routing flags, no `--fallback`, and no guessed effort or model. The
   * brief is a host-bound file path, never the prompt positional. */
  buildWorkerArgs(invocation, _profile, _permissions) {
    const model = requireOptionSafeString(invocation?.selected?.model, 'an explicit model');
    const slash = model.indexOf('/');
    const providerPart = slash > 0 ? model.slice(0, slash) : '';
    const modelPart = slash >= 0 ? model.slice(slash + 1) : '';
    if (slash <= 0 || !modelPart) {
      throw new Error(`OpenClaw worker requires an explicit provider/model id with both parts present: ${JSON.stringify(model)}`);
    }
    if ([providerPart, modelPart].some(part => AUTO_SELECTION_VALUES.includes(part.toLowerCase()))) {
      throw new Error(`OpenClaw worker requires an explicit provider/model id, not an auto-selected value: ${JSON.stringify(model)}`);
    }
    const effort = invocation?.selected?.effort?.value;
    if (typeof effort !== 'string' || !OPENCLAW_DIRECT_THINKING_LEVELS.includes(effort)) {
      throw new Error('OpenClaw worker requires an explicit qualified thinking level (never a CLI default or "adaptive")');
    }
    const cwd = invocation?.cwd;
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) throw new Error('OpenClaw worker requires an absolute workspace');
    const briefPath = invocation?.briefPath;
    if (typeof briefPath !== 'string' || !briefPath.startsWith('/') || briefPath.includes('\0')) {
      throw new Error('OpenClaw worker requires an absolute brief file path');
    }
    return ['agent', 'exec', '--isolated', '--auth-env-only', '--json',
      '--model', model, '--thinking', effort, '--cwd', cwd, '--message-file', briefPath];
  }

  /** `--json` emits exactly one envelope at process end, not a stream: there
   * is nothing to observe mid-run, matching the bundled `final-json` /
   * `progressEvidence: []` health profile. */
  observeHealthEvent() { return null; }

  /** Candidate extractor consumed by the installed driver's extraction hook,
   * which treats any non-null return as "a final was produced". Fails
   * closed: returns `null` for a non-object payload, a self-contradictory
   * `ok`/`status` pair, any non-`"ok"` status (including `ok:false` and
   * `timeout`), or an `ok:true` run with an empty/whitespace `final` -- an
   * exit-zero failure is never a candidate final. */
  parseOutput(stdout) {
    return parseSuccessfulEnvelope(stdout);
  }

  /** Authoritative final-claim gate wired by the #2885 installed loader and
   * by `session-launcher.mjs`'s `finalValid`/`extractFinal` path. Re-validates
   * the envelope strictly (never trusting the exit code alone, even though
   * this CLI's exit code mirrors `status` by construction), then hands only
   * the model's own `final` text to the shared strict `workerClaims` parser
   * -- mirroring `HermesAdapter.parseWorkerFinal` and
   * `ClaudeDirectAdapter.parseWorkerFinal`. An unsuccessful or malformed
   * envelope throws instead of returning a candidate.
   * @param {string|Uint8Array} output
   * @param {{ format?: string }} [options]
   */
  async parseWorkerFinal(output, options = {}) {
    if (options.format === 'mcp') return super.parseWorkerFinal(output, options);
    const text = typeof output === 'string' ? output : Buffer.from(output).toString('utf8');
    const envelope = parseSuccessfulEnvelope(text);
    if (!envelope) throw new Error('OpenClaw worker did not produce a successful agent-exec envelope');
    return super.parseWorkerFinal(envelope.final, { ...options, format: 'json' });
  }

  /** No evidenced stdin abort channel for `agent exec`; stdin is closed. */
  getAbortInput() { return null; }
}

/** Installed-module registration: exactly the one approved adapter ID. */
export function register(factory) {
  factory('openclaw', () => new OpenClawAdapter());
}

export default OpenClawAdapter;
