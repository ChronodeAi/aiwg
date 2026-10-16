/**
 * Warp / Oz CLI direct-worker driver (roctinam/aiwg#2905).
 *
 * Version-bound to the installed `warp-terminal` ("Oz v0.2026.10.07.08.29.
 * stable_00") on host 'noodle' (apt package; there is NO `oz` symlink on
 * this host, so the real executable is `warp-terminal` and Oz commands are
 * its `agent`/`model`/`mcp`/... subcommands). Evidence: captured
 * `--help`/`agent --help`/`agent run --help` (grade H,
 * .aiwg/working/s1-scratch/cli-help/warp-0.2026.10.07.txt) plus live,
 * no-model conductor argument-parse probes against the real binary on
 * 2026-10-11 (grade R; the host has no login, so every probe below stops at
 * most at the auth check, never a model):
 *
 *   $ warp-terminal agent run --prompt --output-format bogus </dev/null
 *   error: a value is required for '--prompt <PROMPT>' but none was supplied
 *   $ warp-terminal agent run --output-format bogus --prompt x </dev/null
 *   error: invalid value 'bogus' for '--output-format <OUTPUT_FORMAT>'
 *     [possible values: json, ndjson, pretty, text]
 *   $ warp-terminal agent run -f <missing>.json --output-format json </dev/null
 *   error: the following required arguments were not provided:
 *     <--prompt <PROMPT>|--saved-prompt <SAVED_PROMPT>|--task-id <TASK_ID>|--skill <SKILL>>
 *   $ warp-terminal agent run --skill --output-format bogus </dev/null
 *   error: a value is required for '--skill <SKILL>' but none was supplied
 *   $ warp-terminal agent run --output-format json --model MODEL_PROBE \
 *       --cwd <dir> --skill aiwg-direct-brief </dev/null
 *   You are not logged in - please log in with `warp-terminal login` to continue.
 *
 * These probes prove: (1) `--prompt` has normal clap arity (a flag-shaped
 * next token is refused as its value, never swallowed — unlike the
 * Antigravity `--print` bug); (2) `-f/--file` is NOT a member of the
 * required `<--prompt|--saved-prompt|--task-id|--skill>` group, so it
 * cannot by itself satisfy the run and cannot be assumed to carry the brief
 * (its own internal schema is undocumented and unverified — never invented
 * here); (3) `--skill` has the same safe arity as `--prompt`; (4) the full
 * historical argv template (`--output-format json --model <M> --cwd <dir>
 * --skill aiwg-direct-brief`) parses cleanly together and reaches the same
 * auth stop as every other combination — no argument error anywhere in
 * this template.
 *
 * BRIEF TRANSPORT (the governing constraint): `--prompt` places the brief
 * text on argv, which this profile never does. The only other
 * required-group member that can carry free-form text is `--skill`
 * ("Use a skill as the base prompt for the agent" when given without
 * `--prompt`, per `agent run --help`), but a skill is a named file under
 * the help-listed skill directories that must already exist before the run.
 * The search root relative to --cwd and missing-skill behavior are UNVERIFIED:
 * every real skill probe stopped at the login gate. There is
 * no CLI flag to inline its content. `buildWorkerArgs` below is a pure
 * function (per #3002/#2998 precedent: it must never write files or touch
 * the network), so it cannot create that file itself. This profile
 * therefore exports {@link buildWarpBriefSkillFile}, a pure function
 * returning the exact relative path and Markdown content an execution-time
 * file-generation primitive would need to write before this argv runs —
 * that primitive does not exist in the shared session-launcher yet
 * (tracked as the same class of need as #2998/#3002: "an execution-time
 * generated artifact"). Until it exists, `--skill` dispatch is reported
 * honestly as unqualified/blocked, never silently invented as working.
 *
 * Other controls this profile found NO flag for at all in the full
 * `agent run --help` capture, so they are `unavailable` rather than
 * invented: `--effort`/reasoning-effort, any sandbox/approval/trust flag,
 * and any per-run permission-bypass flag. Oz can also target a CLOUD
 * `environment`/`runner` (`-e/--environment <ID>`) or a third-party
 * `--harness claude|codex` mode; this profile NEVER emits either or the
 * cloud subcommand. Execution location remains unverified until an
 * authenticated run.
 * `--no-snapshot` ("Disable the end-of-run workspace snapshot upload") is
 * always emitted to disable the documented snapshot upload.
 *
 * Output: `--output-format json` is help-documented to exist, but neither
 * `--help` nor the (generic, not grammar-establishing) binary `strings`
 * output name a success/error envelope shape, and no login exists to
 * observe one live. No event grammar is invented. Like Copilot direct,
 * `parseOutput` always returns null and `parseWorkerFinal` always throws:
 * even schema-valid claims text cannot establish an Oz terminal answer.
 * The intended parsing rule is documented in docs/providers/warp-direct.md,
 * not active here.
 *
 * Auth: a Warp login or `WARP_API_KEY` (env only, never the `--api-key`
 * flag). The manual smoke run is blocked until an operator provides one.
 *
 * Installed-module shape: static `interfaceVersion`/`register` exports so
 * the #2885 loader can approve this file by digest under `installed:warp`.
 * No prior `warp` direct/legacy adapter class exists in this tree
 * (confirmed against origin/main before this change), so there is no
 * legacy contract to preserve and no `warp-direct` id is needed — this
 * class is registered directly under `warp` (the antigravity/openclaw/
 * openhuman precedent for a brand-new, direct-only adapter).
 *
 * This class extends `ProviderAdapter` (unlike `openhuman-adapter.mjs`,
 * which does not) specifically so the installed driver's claims hook
 * (`session-launcher.mjs` ~480, `extractFinal`/`parseWorkerFinal`) is
 * actually wired: `worker-installation.mjs` only forwards
 * `parseWorkerFinal` when `typeof instance.parseWorkerFinal === 'function'`,
 * and a bare class with no override and no base class has no such method at
 * all. The override below refuses claims until an authenticated output
 * envelope establishes which field is the terminal answer.
 */
import { ProviderAdapter } from './provider-adapter.mjs';

export const interfaceVersion = 1;

/** Live `warp-terminal --version` (noodle, 2026-10-11): "Oz v0.2026.10.07.08.29.stable_00". */
export const WARP_SUPPORTED_VERSIONS = Object.freeze(['0.2026.10.07.08.29.stable_00']);

/** No `--effort`/reasoning flag is documented anywhere in the captured
 * `agent`/`agent run --help`; this control is unavailable, never guessed. */
export const WARP_DIRECT_EFFORT_VALUES = Object.freeze([]);

/** No sandbox/permission-mode flag is documented for a local run; the only
 * honestly reportable contract is an external boundary (module doc above). */
export const WARP_DIRECT_SANDBOX_MODES = Object.freeze(['external']);

/** Case-insensitive "let the tool pick" sentinels; refused defensively
 * exactly like other profiles even though no CLI doc names one for `--model`. */
const WARP_AUTO_MODEL_SPELLINGS = Object.freeze(['auto', 'default']);

/** Injective mapping of a unique invocation ID; never sanitize or truncate
 * IDs into colliding paths. Prefix plus ID is at most 63 ASCII characters. */
export function buildWarpBriefSkillName(invocationId) {
  if (typeof invocationId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,51}$/.test(invocationId)) {
    throw new Error('Warp worker invocation id cannot be mapped safely: require 1-52 lowercase ASCII letters, digits or hyphens, starting with a letter or digit');
  }
  return `aiwg-brief-${invocationId}`;
}

/** Control characters (incl. NUL, CR, LF, TAB) are never valid inside a single argv token. */
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const WHITESPACE_PATTERN = /\s/;

function assertSingleTokenValue(value, label) {
  if (typeof value !== 'string' || !value || CONTROL_CHAR_PATTERN.test(value) || WHITESPACE_PATTERN.test(value)) {
    throw new Error(`Warp worker ${label} must be a non-empty single token with no whitespace or control characters`);
  }
  if (value.startsWith('-')) {
    throw new Error(`Warp worker ${label} must not look like a CLI option; option-prefixed values are refused: ${value}`);
  }
}

/**
 * Pure content/path generator for the local skill file `--skill` resolves
 * against (module doc above: "Skills are searched in `.agents/skills/`,
 * `.warp/skills/`, `.claude/skills/`, and `.codex/skills/`", `agent run
 * --help`). This function only RETURNS the intended relative path and
 * Markdown content; it never writes anything (argv rendering, and
 * everything this profile exports, stays pure — #3002). An execution-time
 * file-generation primitive in the shared session-launcher is the missing
 * piece that would actually place this file before the rendered argv runs;
 * until that exists, the `skill`/brief-transport control stays unqualified.
 * The intended search root is unverified. Execution-time generation must
 * refuse existing paths, clean up afterward, and never commit the file.
 * @param {string} brief
 * @param {string} invocationId
 * @returns {{ relativePath: string, content: string }}
 */
export function buildWarpBriefSkillFile(brief, invocationId) {
  if (typeof brief !== 'string' || !brief || brief.includes('\0')) {
    throw new Error('Warp worker requires a non-empty brief to render a skill file for');
  }
  const name = buildWarpBriefSkillName(invocationId);
  const frontmatter = `---\nname: ${name}\ndescription: AIWG direct worker brief (generated per invocation; never reused across briefs)\n---\n\n`;
  return { relativePath: `.agents/skills/${name}/SKILL.md`, content: `${frontmatter}${brief}\n` };
}

export class WarpAdapter extends ProviderAdapter {
  /** @returns {string} */
  getBinary() { return 'warp-terminal'; }

  /** @returns {string} */
  getName() { return 'warp'; }

  /** @returns {import('./provider-adapter.mjs').ProviderCapabilities} */
  getCapabilities() {
    return {
      streamJson: false, sessionResume: false, budgetControl: false, systemPrompt: false,
      agentMode: false, mcpConfig: false, maxTurns: false,
    };
  }

  /** No qualified Ralph-loop session; direct-only, mirroring
   * openhuman-adapter.mjs/openclaw-adapter.mjs so no new argv-prompt path
   * is ever added for the legacy loop. */
  buildSessionArgs() {
    throw new Error('Warp has no qualified Ralph loop session; use the direct worker profile');
  }

  buildAnalysisArgs() { return this.buildSessionArgs(); }

  /**
   * Driver-owned argv after the binary (module doc above). Explicit model
   * and cwd; `--output-format json`; the required run-selector group is
   * satisfied by `--skill` with an invocation-specific token — never `--prompt`
   * with brief text, never a cloud `--environment`/`--harness`. NEVER
   * writes the skill file itself (pure); see {@link buildWarpBriefSkillFile}.
   * @param {{ invocationId?: unknown, selected?: { model?: unknown, effort?: { value?: unknown } }, cwd?: unknown, brief?: unknown }} invocation
   * @param {unknown} _profile
   * @param {{ sandbox?: unknown }} [permissions]
   * @returns {string[]}
   */
  buildWorkerArgs(invocation, _profile, permissions = {}) {
    const model = invocation?.selected?.model;
    if (typeof model !== 'string' || !model || model.includes('\0')) {
      throw new Error('Warp worker requires an explicit model');
    }
    assertSingleTokenValue(model, 'model');
    if (WARP_AUTO_MODEL_SPELLINGS.includes(model.toLowerCase())) {
      throw new Error(`Warp worker requires an explicit model, never '${model.toLowerCase()}'`);
    }
    const effort = invocation?.selected?.effort?.value ?? null;
    if (effort !== null) {
      throw new Error('Warp has no evidenced reasoning-effort control; effort must not be supplied');
    }
    if (typeof invocation?.cwd !== 'string' || !invocation.cwd.startsWith('/') || invocation.cwd.includes('\0')) {
      throw new Error('Warp worker requires an absolute workspace');
    }
    const brief = invocation?.brief;
    if (typeof brief !== 'string' || !brief || brief.includes('\0')) {
      throw new Error('Warp worker requires a non-empty brief');
    }
    const sandbox = permissions?.sandbox ?? 'external';
    if (!WARP_DIRECT_SANDBOX_MODES.includes(sandbox)) {
      throw new Error(`Warp worker sandbox is not a qualified direct mode: ${String(sandbox)}`);
    }
    const skill = buildWarpBriefSkillName(invocation?.invocationId);
    return [
      'agent', 'run',
      '--output-format', 'json',
      '--model', model,
      '--cwd', invocation.cwd,
      '--skill', skill,
      '--no-snapshot',
    ];
  }

  /** No documented stdin abort channel; nothing is sent on stdin (module doc). */
  getAbortInput() { return null; }

  /** No event stream or final-only envelope is evidenced; nothing to
   * observe mid-run, matching the pre-existing #2896 health stub for this
   * provider (`outputFraming: "plain"`, `progressEvidence: []`). */
  observeHealthEvent() { return null; }

  /**
   * Candidate extraction for the installed driver's `extractFinal` hook.
   * No vendor envelope is evidenced for this CLI (module doc above), so
   * all output is refused, including schema-valid workerClaims text.
   * Mirrors the Copilot direct fail-closed extraction hook.
   * @param {string} _stdout
   * @returns {null}
   */
  parseOutput(_stdout) {
    return null;
  }

  /** Refuse every transport until an authenticated Oz terminal envelope
   * establishes the answer field. Structural validity is insufficient. */
  async parseWorkerFinal(_output, _options = {}) {
    const error = new Error('Warp final answer extraction is unavailable until the Oz output envelope is observed in an authenticated run (docs/providers/warp-direct.md)');
    error.name = 'WorkerContractError';
    error.code = 'OG_CONTRACT_UNSUPPORTED';
    throw error;
  }

  /** #2915 follow-up: `parseWorkerFinal` above always throws, for every
   * input -- there is no observed final envelope to extract from yet, ever.
   * A canary admitted for this CLI could structurally never report a
   * verified success, so this CLI is never eligible for recovery-breaker
   * gating at all (see `ProviderAdapter.supportsAttemptVerification`). */
  supportsAttemptVerification() { return false; }
}

/** Installed-module registration: exactly the one approved adapter ID. */
export function register(factory) {
  factory('warp', () => new WarpAdapter());
}

export default WarpAdapter;
