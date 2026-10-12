/**
 * GitHub Copilot CLI direct-worker driver (B-OG-36, roctinam/aiwg#2901).
 *
 * Version-bound to the real installed `copilot` 1.0.95 `--help` /
 * `copilot help <topic>` output (help/version syntax only; captured on host
 * 'noodle' 2026-10-10, see .aiwg/working/s1-scratch/cli-help/copilot-1.0.95.txt
 * and `copilot help sandbox|permissions|config|environment`; never a live
 * prompted run):
 *
 *   copilot -p "Follow the instructions in the attached file exactly." \
 *     --attachment ${briefPath} --model ${model} --reasoning-effort ${effort} \
 *     -C ${workspace} --output-format json --no-ask-user \
 *     --no-custom-instructions --disable-builtin-mcps \
 *     [--allow-tool <pattern> ...] [--deny-tool <pattern> ...]
 *
 * Brief transport: `-p/--prompt <text>` only accepts inline argv text ("Execute
 * a prompt in non-interactive mode"); there is no `--prompt-file`/stdin option
 * for the initial prompt (`copilot --help`, Options). The brief therefore
 * never enters argv or stdin: it rides on `--attachment <path>` ("Attach a
 * file (image or native document) to the initial prompt; only valid in
 * non-interactive mode"), mirroring the OpenCode `-f`/`--file` attached-file
 * pattern (#2904/#2985) for a CLI whose main prompt flag is argv-only. `-p`
 * is therefore fixed to a short, content-free instruction
 * (`COPILOT_FIXED_PROMPT`) that never carries brief bytes; `buildWorkerArgs`
 * refuses anything else in that slot.
 *
 * Non-interactive invariants: `--no-ask-user` disables the agent's own
 * `ask_user` tool ("the agent works autonomously without asking questions").
 * Tool-approval prompts are a *separate* mechanism: `--help` states
 * `--allow-all-tools` is "required for non-interactive mode", but the
 * Implementation notes for this issue are explicit — scoped `--allow-tool`
 * controls only, never `--allow-all-tools`/`--allow-all`/`--yolo`. This
 * profile never emits the blanket flags; the resolved permission tuple's
 * `allowTools`/`denyTools` become repeated `--allow-tool`/`--deny-tool`
 * tokens instead. Whether a tool outside that scoped allow-list fails closed
 * or blocks indefinitely in a non-interactive run is NOT evidenced from
 * `--help` alone and stays unqualified pending a live run (out of scope for
 * this task).
 *
 * Sandbox: root `copilot --help`'s Options list has no `--sandbox` flag —
 * only `copilot help sandbox` prose mentions one, and the OS-level MXC
 * sandbox needs host prerequisites (bwrap/slirp4netns/iptables on Linux) that
 * are not probed here. This profile never emits it (and never
 * `--allow-all-paths`), relying instead on the CLI's own default path
 * restriction (cwd + PATH dirs + temp dir + user profile). Sandbox stays
 * `unavailable`, not invented.
 *
 * Model/effort: `--model <model>` ("use 'auto' to let Copilot pick
 * automatically" — the direct profile refuses `auto` and any case-insensitive
 * spelling of it, and refuses the generic Ralph-loop aliases) and
 * `--reasoning-effort <level>` (`none|minimal|low|medium|high|xhigh|max`,
 * `copilot --help`) are always explicit, never a CLI default.
 *
 * Final output: `--output-format json` is "JSONL, one JSON object per line"
 * per `--help`; there is no output-file flag for the agent's final answer
 * (`--usage-output-file` writes usage statistics only, not the response, and
 * is not wired here). The CLI's own JSONL event-type vocabulary is NOT
 * documented in `--help`, and the installed 1.0.95 package is a compiled
 * per-architecture native binary with no readable bundled JS source to read
 * instead (unlike e.g. Pi's `chunk-*.js`) — so no event-level health grammar
 * is invented. `observeHealthEvent` always returns null (mirrors
 * openhuman-adapter.mjs / factory-adapter.mjs / hermes-adapter.mjs for
 * providers with no evidenced grammar); completion is exit-code gated only,
 * and `parseOutput`/`parseDirectFinal` only enforce the one evidenced
 * contract (every non-empty line is a JSON object) plus a non-empty stream.
 *
 * CONSERVATIVE error-shape guard (not an observed Copilot event name —
 * `--help` documents no JSONL event vocabulary at all, see above): any
 * parsed line whose `type` is `"error"`, or which carries a top-level
 * non-null `error` field, fails the final even at exit 0. This is a
 * defensive guard against a common "exit 0 but the stream itself reports
 * failure" shape seen across many CLIs, not an evidenced Copilot contract.
 * It is applied both in `parseOutput` here and in the generic
 * `observeProviderHealthEvent('copilot', ...)` branch in
 * `tools/ralph-external/lib/worker-health.mjs`, so neither the final parse
 * nor the health observer can report `completed`/`OK` for it.
 *
 * Workspace: `-C <directory>` ("Change working directory before doing
 * anything else") binds the worker's cwd explicitly.
 *
 * Untrusted-surface denial (mirrors Pi's `--no-context-files`/`--no-mcp`
 * rationale, #2910): `--no-custom-instructions` stops loading AGENTS.md and
 * related files from the workspace, and `--disable-builtin-mcps` disables
 * the built-in `github-mcp-server`/`githubiq` MCP servers so the AIWG
 * `worker-invoke` bridge remains the one MCP route this profile authorizes.
 *
 * Installed-module shape: static `interfaceVersion` and `register` exports
 * so the #2885 loader can approve this file by digest under
 * `installed:copilot` (mirroring #2911 openhuman-adapter.mjs). Like
 * OpenHuman, this is a standalone class (not a `ProviderAdapter` subclass,
 * not registered in the legacy Ralph-loop registry): Copilot has no
 * qualified Ralph-loop session, only the direct worker profile.
 */

export const interfaceVersion = 1;

export const COPILOT_SUPPORTED_VERSIONS = Object.freeze(['1.0.95']);
export const COPILOT_DIRECT_EFFORT_VALUES = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** Brief transport: an attached file, never argv text and never stdin. */
export const COPILOT_DIRECT_STDIN = 'closed';
/** Fixed, content-free initial prompt: never the brief; the brief rides on `--attachment`. */
export const COPILOT_FIXED_PROMPT = 'Follow the instructions in the attached file exactly.';
/** No per-call OS sandbox flag is safely evidenced (see module doc); external boundary only. */
export const COPILOT_DIRECT_SANDBOX_MODES = Object.freeze(['external']);
/** Case-insensitive refusal list: Copilot's own CLI-chosen routing, never selected here. */
const COPILOT_AUTO_MODEL_SPELLINGS = Object.freeze(['auto']);
/** Generic Ralph-loop aliases are never a valid direct-profile model. */
const COPILOT_GENERIC_ALIASES = Object.freeze(['opus', 'sonnet', 'haiku']);
/** Blanket bypass flags/words this profile must never emit via a tool pattern. */
const COPILOT_BANNED_TOOL_PATTERNS = Object.freeze(['--allow-all-tools', '--allow-all', '--yolo', '*']);

/** Control characters (incl. NUL, CR, LF, TAB) are never valid inside a single tool pattern token. */
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

function assertPlainToolPattern(value, label) {
  if (typeof value !== 'string' || !value.trim() || CONTROL_CHAR_PATTERN.test(value)) {
    throw new Error(`Copilot worker ${label} pattern must be a non-empty single-line string with no control characters`);
  }
  if (COPILOT_BANNED_TOOL_PATTERNS.includes(value)) {
    throw new Error(`Copilot worker ${label} pattern must be scoped, never a blanket bypass: ${value}`);
  }
  // A real variadic parser treats any "-"-prefixed token as the START of a
  // new option, not a value for --allow-tool/--deny-tool. Refuse these here
  // so a caller can never smuggle an option token (e.g. --allow-all-paths,
  // --allow-all-urls) through the variadic tool-pattern slot.
  if (value.startsWith('-')) {
    throw new Error(`Copilot worker ${label} pattern must not look like a CLI option; option-prefixed tokens are refused: ${value}`);
  }
}

export class CopilotAdapter {
  getBinary() { return 'copilot'; }
  getName() { return 'copilot'; }
  getCapabilities() {
    return {
      streamJson: false, sessionResume: false, budgetControl: false, systemPrompt: false,
      agentMode: true, mcpConfig: false, maxTurns: false,
    };
  }
  buildSessionArgs() {
    throw new Error('Copilot has no qualified Ralph loop session; use the direct worker profile');
  }
  buildAnalysisArgs() { return this.buildSessionArgs(); }

  /**
   * Driver-owned argv after the binary for the version-bound direct-shell
   * profile. Every control is explicit: exact model (never `auto` or a
   * generic alias), explicit reasoning effort, the workspace via `-C`, the
   * brief as an attached file (never argv/stdin content), `--no-ask-user`
   * plus the untrusted-surface denials, and only scoped
   * `--allow-tool`/`--deny-tool` permission tokens — never
   * `--allow-all-tools`/`--allow-all`/`--yolo`.
   *
   * @param {{ selected?: { model?: unknown, effort?: { value?: unknown } }, cwd?: unknown, briefPath?: unknown }} invocation
   * @param {unknown} _profile
   * @param {{ allowTools?: unknown, denyTools?: unknown }} [permissions]
   * @returns {string[]}
   */
  buildWorkerArgs(invocation, _profile, permissions) {
    const model = invocation?.selected?.model;
    if (typeof model !== 'string' || !model || model.includes('\0')) {
      throw new Error('Copilot worker requires an explicit model');
    }
    if (COPILOT_AUTO_MODEL_SPELLINGS.includes(model.toLowerCase())) {
      throw new Error("Copilot worker requires an explicit model, never 'auto'");
    }
    if (COPILOT_GENERIC_ALIASES.includes(model.toLowerCase())) {
      throw new Error(`Copilot worker requires an exact observed model, not the generic alias '${model}'`);
    }
    const effort = invocation?.selected?.effort?.value ?? null;
    if (effort === null || !COPILOT_DIRECT_EFFORT_VALUES.includes(effort)) {
      throw new Error('Copilot worker requires an explicit qualified reasoning effort (never a CLI default)');
    }
    const cwd = invocation?.cwd;
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) {
      throw new Error('Copilot worker requires an absolute workspace');
    }
    const briefPath = invocation?.briefPath;
    if (typeof briefPath !== 'string' || !briefPath.startsWith('/') || briefPath.includes('\0')) {
      throw new Error('Copilot worker requires an absolute brief-file path');
    }
    const sandbox = permissions?.sandbox ?? 'external';
    if (!COPILOT_DIRECT_SANDBOX_MODES.includes(sandbox)) {
      throw new Error(`Copilot worker sandbox is not a qualified direct mode: ${String(sandbox)}`);
    }
    const allowTools = permissions?.allowTools;
    if (!Array.isArray(allowTools) || allowTools.length === 0) {
      throw new Error('Copilot worker requires at least one explicit scoped --allow-tool pattern (never --allow-all-tools)');
    }
    for (const pattern of allowTools) assertPlainToolPattern(pattern, '--allow-tool');
    const denyTools = permissions?.denyTools ?? [];
    if (!Array.isArray(denyTools)) throw new Error('Copilot worker denyTools must be an array when present');
    for (const pattern of denyTools) assertPlainToolPattern(pattern, '--deny-tool');
    const args = [
      '-p', COPILOT_FIXED_PROMPT,
      '--attachment', briefPath,
      '--model', model,
      '--reasoning-effort', effort,
      '-C', cwd,
      '--output-format', 'json',
      '--no-ask-user',
      '--no-custom-instructions',
      '--disable-builtin-mcps',
    ];
    for (const pattern of allowTools) args.push('--allow-tool', pattern);
    for (const pattern of denyTools) args.push('--deny-tool', pattern);
    return args;
  }

  /** No evidenced stdin abort channel; stdin is not used by this profile at all. */
  getAbortInput() { return null; }

  /** Unknown CLI grammar: no event-level health signal is evidenced from
   * `--help` and the installed binary has no readable bundled source (see
   * module doc), so no event kind is invented. Completion stays exit-code
   * gated only. */
  observeHealthEvent() { return null; }

  /**
   * #2995 round 3 (item D): this installed hook's job is to decide whether
   * a run's final is a trustworthy CANDIDATE (src/models/
   * worker-installation.mjs ~l.730, session-launcher.mjs ~l.462 publish
   * `terminalSuccess`/write a candidate-evidence file on anything
   * non-null). There is still no evidenced answer field for Copilot (module
   * doc above — compiled binary, no readable source, live qualification
   * blocked on auth) — only the one evidenced structural contract (every
   * non-empty line is a clean JSON object, never error-shaped). That
   * structural check alone is NOT an affirmative success signal: it is
   * equally true of a clean stream that never actually answered anything.
   * Returning a success-looking `{events}` object here would therefore
   * publish a false candidate for a run this profile can never actually
   * validate (`parseWorkerFinal` below always throws regardless). This
   * method always returns null so no such candidate is ever published;
   * `parseDirectFinal` below keeps the one structural check for any other
   * internal caller that still wants it (test-only today).
   * @param {string} _stdout
   * @returns {null}
   */
  parseOutput(_stdout) {
    return null;
  }

  /**
   * The one evidenced structural contract (module doc above), kept
   * separate from `parseOutput` (which must always return null — see
   * above): any non-empty line must be a clean JSON object and never
   * error-shaped. Used only for tests/diagnostics; never wired as the
   * installed `extractFinal` hook.
   * @param {string} stdout
   * @returns {{ events: object[] } | null}
   */
  parseDirectFinal(stdout) {
    if (typeof stdout !== 'string' || !stdout.trim()) return null;
    const events = [];
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { return null; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
      // CONSERVATIVE GUARD ONLY (see module doc): never an evidenced Copilot
      // event name. Any line shaped like an error — `type: "error"` or a
      // top-level non-null `error` field — fails the final outright, even
      // though exit code is evaluated separately by the caller.
      if (event.type === 'error' || (event.error !== undefined && event.error !== null)) return null;
      events.push(event);
    }
    return events.length ? { events } : null;
  }

  /**
   * #2995: production marks a run `completed` only when `parseWorkerFinal`
   * succeeds (src/models/worker-installation.mjs ~l.733,
   * tools/ralph-external/session-launcher.mjs ~l.477). Every other direct
   * profile in this effort extracts its final answer text from its own
   * strict event rule and hands that text to the shared strict
   * `workerClaims` parser. Copilot cannot do the same: its JSONL event
   * vocabulary is wholly unevidenced (module doc above — the installed
   * binary is compiled, with no readable bundled source, and a live
   * qualification run is blocked on credentials per
   * docs/providers/copilot-direct.md). `parseOutput()` above therefore
   * only proves "every line is a clean JSON object"; it cannot name which
   * field, if any, holds the model's final answer, and inventing one here
   * would be exactly the kind of unevidenced grammar this profile's
   * `observeHealthEvent`/`parseOutput` deliberately refuse to guess.
   * This override fails closed unconditionally — including for
   * `options.format === 'mcp'`, since this profile has no evidenced MCP
   * transport either — until the event stream is observed and the real
   * answer field is documented.
   * @param {string|Uint8Array} _output
   * @param {Object} [_options]
   * @returns {Promise<never>}
   */
  async parseWorkerFinal(_output, _options = {}) {
    // Deliberately no cross-module import here (never a `../../
    // _resolve-impl.mjs`/mission-protocol dependency): unlike every other
    // adapter in this effort, Copilot ships as a flat, standalone module
    // with no sibling files (module doc above), and this override always
    // throws regardless of installed package layout. The error carries the
    // same `code`/`name` shape as mission-protocol's WorkerContractError
    // (OG_CONTRACT_UNSUPPORTED) so callers that branch on `.code` see a
    // consistent, if extraction-unavailable, contract failure.
    const error = new Error(
      'Copilot final answer extraction is unavailable until the event stream is observed (docs/providers/copilot-direct.md)');
    error.name = 'WorkerContractError';
    error.code = 'OG_CONTRACT_UNSUPPORTED';
    throw error;
  }
}

/** Installed-module registration: exactly the one approved adapter ID. */
export function register(factory) {
  factory('copilot', () => new CopilotAdapter());
}

export default CopilotAdapter;
