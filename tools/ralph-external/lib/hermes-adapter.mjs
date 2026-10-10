/**
 * Hermes direct-worker driver (B-OG-48, roctinam/aiwg#2912).
 *
 * Re-verified 2026-10-10 against the per-user install `~/.hermes/hermes-agent`
 * (launcher `~/.local/bin/hermes`), Hermes Agent v0.21.6+387.gdce1e9b
 * (2026.9.24) on host titan — `hermes chat --help` and installed `hermes_cli`
 * source (never run with a prompt). The root `/usr/local/lib/hermes-agent`
 * copy is a STALE 0.20.6 install and is never cited here; all line numbers
 * below are from `~/.hermes/hermes-agent`, which was heavily refactored
 * (`cli.py` split into `hermes_cli/cli_*_mixin.py` / `cli_single_query.py`
 * modules) between 0.20.6 and 0.21.6, so no 0.20.6 `cli.py:NNNN` citation
 * still applies verbatim.
 *
 * Baseline: `hermes chat --query-file - --oneshot --quiet --ignore-user-config
 * --provider PROVIDER -m MODEL --reasoning LEVEL`:
 *
 *  - `--query-file -` reads the single query from stdin to EOF, with nothing
 *    shell-interpreted (`hermes_cli/_parser.py:235-242` flag text; dispatched
 *    at `hermes_cli/main.py:1711-1712`: `if _qfile == "-": args.query =
 *    sys.stdin.read()`). The brief never enters argv.
 *  - `--oneshot` (dest `oneshot_exit`, `_parser.py:243-247`) answers the
 *    query and exits instead of seeding an interactive session.
 *  - `-Q/--quiet` (`_parser.py:262-263`) routes through
 *    `_run_quiet_single_query()` (`hermes_cli/cli_single_query.py:199-343`),
 *    which calls `cli.agent.run_conversation(...)` directly — NOT
 *    `cli.chat()` — and prints stdout via `elif response: print(response)`
 *    (`cli_single_query.py:314-315`) only; no banner, no `session_id:` line
 *    (stderr only, `cli_single_query.py:341`).
 *  - `-m/--model`, `--provider` and `--reasoning LEVEL` are declared directly
 *    on the `chat` subparser (`_parser.py:248-260`).
 *  - `--ignore-user-config` (`_parser.py:303-304`, `chat --help`: "Ignore
 *    ~/.hermes/config.yaml and fall back to built-in defaults (credentials
 *    in .env are still loaded)") pins every approval-policy setting to the
 *    SAFE built-in default regardless of the host's config file — see
 *    "Approval policy is NOT emitted-flag-only" below. Session/auth
 *    credentials still resolve via `.env`, so this never blocks dispatch.
 *
 * EXIT CODE IS NOT SUFFICIENT EVIDENCE OF COMPLETION, even though 0.21.6
 * fixed the specific lying-exit-0 case this adapter was originally written
 * against. `hermes_cli/cli_single_query.py:152-194`
 * (`_single_query_exit_code`, shared by `-q` and `-Q`) now returns exit 1
 * whenever `result.get("failed") or result.get("partial") or
 * result.get("completed") is False` — so the 0.20.6 reasoning-budget-
 * exhaustion case (`agent/turn_truncation.py:95-103` `_THINKING_EXHAUSTED`
 * text, returned via `partial_result()` at `agent/turn_truncation.py:164-180`
 * with `"completed": False, "partial": True` and no `"failed"` key) now
 * exits 1, not 0, on this build: `_single_query_exit_code`'s `partial`/
 * `completed is False` check catches it where the 0.20.6 exit mapper
 * (`cli.py`'s bare `1 if result.get("failed") else 0`) did not. This is a
 * confirmed upstream fix, not a profile change. `parseWorkerFinal` below
 * STILL does not stop at the exit-derived `status` alone, for a narrower,
 * still-live reason: a genuinely `completed` turn's `final_response` is the
 * MODEL's own text, and nothing in the CLI guarantees the model actually
 * emitted the instructed `workerClaims` JSON document — so the final text
 * must also parse as strict JSON (#2890's
 * `ProviderAdapter.parseWorkerFinal`/`parseWorkerOutput`, `format: 'json'`).
 * A warning message, an error string, or any other free text fails that
 * parse regardless of exit code.
 *
 * APPROVAL POLICY IS NOT EMITTED-FLAG-ONLY. `hermes chat --query-file`
 * sessions set `HERMES_SINGLE_QUERY_SESSION=1`
 * (`hermes_cli/cli_single_query.py:514`), routing any tool-approval gate
 * through `approvals.single_query_mode` — but that setting, and the sibling
 * `approvals.mode`, are **host config** (`~/.hermes/config.yaml`), not argv:
 *
 *  - `tools/approval_context.py:298-304` (`_binary_approval_mode()`, used by
 *    `_get_single_query_approval_mode()` at `tools/approval_context.py:313-315`)
 *    accepts `approve/off/allow/yes` as a config value and treats any of
 *    them as "approve" (auto-approve). The BUILT-IN DEFAULT is `"deny"`
 *    (`hermes_cli/config_defaults.py:1682`), but an operator's `config.yaml`
 *    can set `single_query_mode: approve`.
 *  - `approvals.mode` (default `"smart"`, `config_defaults.py:1679`) can be
 *    set to `"off"` in config.yaml, which bypasses approval prompts the same
 *    way `--yolo` does (`tools/approval.py:967`,
 *    `approval_context._get_approval_mode() == "off"`).
 *  - `HERMES_YOLO_MODE` is a process env var, frozen at Python import time
 *    (`tools/approval.py:46`, `_YOLO_MODE_FROZEN =
 *    is_truthy_value(os.getenv("HERMES_YOLO_MODE", ""))`) — if set in the
 *    worker's environment, every approval gate auto-approves
 *    unconditionally.
 *
 * `--ignore-user-config` defeats the first two (the session falls back to
 * the safe built-in defaults: `single_query_mode: deny`, `approvals.mode:
 * smart`, never `off`), so this adapter always emits it. `HERMES_YOLO_MODE`
 * (and any other `HERMES_*` env override) is defeated structurally: the
 * bundled profile's `envAllowlist` is `[]` and the shared shell renderer
 * clears the child environment (`env -i <allowlist-only>`,
 * src/serve/worker-invocation.ts), so an ambient `HERMES_YOLO_MODE` in the
 * conductor's own environment can never reach the child regardless of what
 * the renderer allowlists — proven by an explicit assertion in
 * hermes-direct.test.ts (HD10). The `approval` control still stays
 * `unqualified` on the bundled registry (never invented as `native`): the
 * --ignore-user-config override is real and evidenced, but it is read from
 * source, not from a live run.
 *
 * `-z` is intentionally NOT used as the baseline. Reading the installed
 * source (never running it) shows invariants it cannot meet that
 * `chat --query-file - --oneshot --quiet` does meet: `-z PROMPT`
 * (`hermes_cli/_parser.py:148-153`) takes the brief as a plain positional
 * value with no stdin/file alternative, and `hermes_cli/oneshot.py`
 * unconditionally sets `HERMES_YOLO_MODE=1` (module docstring + line 276)
 * with no disabling flag at all (not even `--ignore-user-config` — that
 * flag is top-level/`chat`-only in its approval-relevant effect; `-z`'s YOLO
 * env-var set happens unconditionally in Python before any config is
 * consulted).
 *
 * There is no `--usage-file`/JSON-usage equivalent for `chat`: that flag is
 * declared only at the top level (`_parser.py:156-160`) and read only by the
 * `-z` dispatch sites (`hermes_cli/oneshot.py:215-324`). Final-output
 * extraction for this profile is stdout text on exit 0 PLUS a strict
 * workerClaims parse, never exit code alone.
 *
 * Installed-module shape: static `interfaceVersion` and `register` exports
 * so the #2885 loader can approve this file by digest under
 * `installed:hermes` (mirrors #2911 openhuman-adapter.mjs). Hermes has no
 * qualified Ralph-loop session (no stream-json, no resume contract
 * evidenced for this profile), so `buildSessionArgs` throws like
 * OpenHuman's. Extends `ProviderAdapter` (like the Codex profile) so
 * `parseWorkerFinal` can delegate to the shared strict `workerClaims`
 * parser via `super.parseWorkerFinal`.
 *
 * Fix round 2 (2026-10-09, conductor manual smoke run on titan, installed
 * Hermes Agent v0.20.6 — the first live run of this profile; re-verified
 * 2026-10-10 against 0.21.6, see above):
 *
 *  1. PROVIDER MUST BE EXPLICIT. `--provider PROVIDER` (`hermes chat
 *     --help`: "Inference provider (default: auto). Built-in or a
 *     user-defined name from `providers:` in config.yaml") is resolved by
 *     `resolve_requested_provider()` (`hermes_cli/runtime_provider.py:490-499`):
 *     an explicit `--provider` wins; otherwise it falls through to
 *     `model.provider` in config.yaml, then `HERMES_INFERENCE_PROVIDER`,
 *     then the literal string `"auto"`. `--ignore-user-config` (always
 *     emitted by this profile) removes the config.yaml fallback, and the
 *     renderer's empty `envAllowlist` removes the env-var fallback, so an
 *     omitted `--provider` resolves to `"auto"` — picking whatever
 *     ambient/pooled credential Hermes finds, in violation of this
 *     profile's explicit-selection invariant. The 0.20.6 smoke run
 *     reproduced this exactly: omitting `--provider` failed with "No
 *     inference provider configured" under `--ignore-user-config`; adding
 *     `--provider openrouter` (with `OPENROUTER_API_KEY` set in the process
 *     env, never on argv) succeeded. A 0.21.6 conductor smoke run with
 *     `--provider openrouter -m anthropic/claude-sonnet-4.6 --reasoning low`
 *     passed (exit 0, stdout exactly the instructed answer, confirming
 *     `resolve_requested_provider` still works identically).
 *     `buildWorkerArgs` therefore always emits `--provider
 *     <selected.inferenceProvider>`, mirroring how the resolved worker
 *     tuple already carries `inferenceProvider` alongside `model`
 *     (`src/mission-protocol/types.ts:161`,
 *     `src/serve/worker-invocation.ts:418-419`) — the same selection field
 *     every other multi-provider adapter reads (compare OpenCode's
 *     `provider/model` composition in
 *     `tools/ralph-external/lib/opencode-adapter.mjs`). A missing,
 *     non-string, or literal `"auto"` provider throws; `"auto"` is
 *     rejected explicitly because it is the exact silent-fallback value
 *     `resolve_requested_provider()` produces when no provider is
 *     resolved, and this profile must never emit it deliberately.
 *  2. A STARTUP DIAGNOSTIC ON STDOUT (0.20.6 only — REMOVED in 0.21.6).
 *     On 0.20.6, `_ensure_tirith_security()` (in that build's `cli.py:8805-8822`)
 *     printed a `_cprint`-rendered warning line to stdout the first time a
 *     `CLI` instance was constructed, when the `tirith` scanner binary was
 *     not installed on the host: `  {_DIM}⚠ tirith security scanner enabled
 *     but not available — command scanning will use pattern matching
 *     only{_RST}`. The 0.21.6 conductor smoke run did NOT see this line, and
 *     source confirms why: the tirith scanner itself was removed from
 *     Hermes — `hermes_cli/config_migrations.py:686-702` ("the bundled
 *     tirith scanner left Hermes... security.tirith_* dropped; the bundled
 *     scanner is gone") — and no `tirith` reference remains anywhere in
 *     `~/.hermes/hermes-agent/cli.py` or any `_cprint` call site. A broader
 *     grep of every `_cprint(...⚠...)` call across `~/.hermes/hermes-agent`
 *     found three bare-`⚠` sites, all interactive-only and none reachable
 *     from this profile's `--quiet` dispatch: `/model`'s switch-warning
 *     (`hermes_cli/cli_model_switch_mixin.py:174`), `/help skills`'
 *     collision note (`hermes_cli/cli_info_mixin.py:274`), and
 *     `_chat_expand_context_references()`'s `@file:`/`@diff`/`@folder:`
 *     warnings inside `cli.chat()`
 *     (`hermes_cli/cli_chat_turn_mixin.py:152-173`) — but `--quiet` never
 *     calls `cli.chat()` at all (it calls `cli.agent.run_conversation()`
 *     directly via `_run_quiet_single_query`, see above), so even that path
 *     is unreachable here. `parseWorkerFinal`'s stripping of a leading
 *     diagnostic line is therefore DEFENSIVE/forward-compatible tolerance,
 *     not a live 0.21.6 requirement: it strips ONLY leading lines matching
 *     that exact diagnostic shape (optional leading whitespace, optional
 *     ANSI SGR codes, a bare `⚠` marker, free text to end of line) before
 *     the strict final parse — see `stripHermesStartupDiagnostics` below —
 *     and is kept because it is harmless on 0.21.6 (no such line appears)
 *     and still useful against older builds or a future regression. A
 *     diagnostic that appears after the real answer, or any unrecognized
 *     preamble text, is left untouched by the stripper and correctly fails
 *     the strict JSON parse (trailing/leading non-JSON content is rejected
 *     by `parseStrictWorkerJson`).
 */
import { ProviderAdapter } from './provider-adapter.mjs';

export const interfaceVersion = 1;

export const HERMES_SUPPORTED_VERSIONS = Object.freeze(['0.21.6']);
/** `--reasoning LEVEL`, `hermes chat --help`, minus the shared resolver's denied `ultra`. */
export const HERMES_DIRECT_EFFORT_VALUES = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Matches exactly ONE leading Hermes startup-diagnostic line of the shape
 * `_cprint` renders (module docstring, Fix round 2 #2): optional leading
 * whitespace, zero or more ANSI SGR escape sequences (e.g. `_DIM` = the
 * dim/italic SGR sequence, `_RST` = the reset sequence), a bare `⚠` marker
 * (U+26A0, NOT immediately followed by the U+FE0F variation selector), then
 * any text up to end of line. Re-verified against 0.21.6
 * (`~/.hermes/hermes-agent`): no `_cprint`-reachable site in this profile's
 * `--quiet` dispatch emits this shape any more (module docstring Fix round 2
 * #2) — the three remaining bare-`⚠` `_cprint` sites found by grep
 * (`hermes_cli/cli_model_switch_mixin.py:174`,
 * `hermes_cli/cli_info_mixin.py:274`,
 * `hermes_cli/cli_chat_turn_mixin.py:173`) are all interactive-only or
 * unreachable from `--quiet`. The U+FE0F exclusion remains deliberate and
 * source-confirmed: every model/agent-facing warning the final response
 * text can legitimately start with (`agent/turn_truncation.py:95-103` the
 * reasoning-budget-exhaustion text HD05b covers;
 * `agent/account_usage.py:543`, `agent/agent_init.py:738,1145`,
 * `agent/stream_diag.py:166`, ...) uses the emoji-presentation `⚠️`, never
 * the bare marker. This is the ONLY thing that lets the stripper tell a
 * genuine CLI diagnostic apart from a model response that happens to start
 * a line with a warning glyph. Otherwise deliberately narrow: this never
 * strips a line that lacks the marker, and never strips past the first
 * newline, so unrecognized preamble or a diagnostic-shaped line that
 * follows real content is left untouched for the strict parse below to
 * reject.
 */
const HERMES_STARTUP_DIAGNOSTIC_LINE = /^[ \t]*(?:\x1b\[[0-9;]*m)*⚠(?!️)[^\n]*\r?\n/;

/**
 * Strip every leading Hermes startup-diagnostic line (zero or more) from
 * `output`, in order, stopping at the first line that does not match. Only
 * ever consumes from the START of the string — a diagnostic that appears
 * after the real final response is never touched, nor is arbitrary
 * preamble text that happens to contain `⚠` mid-line.
 * @param {unknown} output
 * @returns {unknown}
 */
export function stripHermesStartupDiagnostics(output) {
  if (typeof output !== 'string') return output;
  let rest = output;
  while (HERMES_STARTUP_DIAGNOSTIC_LINE.test(rest)) {
    rest = rest.replace(HERMES_STARTUP_DIAGNOSTIC_LINE, '');
  }
  return rest;
}

export class HermesAdapter extends ProviderAdapter {
  getBinary() { return 'hermes'; }
  getName() { return 'hermes'; }
  getCapabilities() {
    return { streamJson: false, sessionResume: false, budgetControl: false, systemPrompt: false,
      agentMode: false, mcpConfig: false, maxTurns: false, rpcAbort: false };
  }
  buildSessionArgs() {
    throw new Error('Hermes has no qualified Ralph loop session; use the direct worker profile');
  }
  buildAnalysisArgs() { return this.buildSessionArgs(); }

  /**
   * Driver-owned argv after the binary: `chat --query-file - --oneshot
   * --quiet --ignore-user-config --provider <provider> -m <model>
   * --reasoning <effort>`. The brief never enters argv (it travels on
   * stdin via `--query-file -`). `--ignore-user-config` is always emitted:
   * it pins `approvals.mode`/`single_query_mode` to their safe built-in
   * defaults regardless of the host's config.yaml (see module docstring).
   * No sandbox/approval flag is invented beyond that — there is no such
   * flag on this CLI. `--provider` is always emitted and taken from the
   * resolved selection's `inferenceProvider`, never left to the CLI's own
   * `auto` default (module docstring, Fix round 2 #1).
   *
   * @param {{ selected?: { model?: unknown, inferenceProvider?: unknown, effort?: { value?: unknown } }, cwd?: unknown, brief?: unknown }} invocation
   * @param {unknown} _profile
   * @param {unknown} _permissions
   * @returns {string[]}
   */
  buildWorkerArgs(invocation, _profile, _permissions) {
    const brief = invocation?.brief;
    if (typeof brief !== 'string' || !brief || brief.includes('\0')) {
      throw new Error('Hermes worker requires a non-empty brief');
    }
    const model = invocation?.selected?.model;
    if (typeof model !== 'string' || !model || model.includes('\0')) {
      throw new Error('Hermes worker requires an explicit model');
    }
    const provider = invocation?.selected?.inferenceProvider;
    if (typeof provider !== 'string' || !provider || provider.includes('\0') || provider.toLowerCase() === 'auto') {
      throw new Error('Hermes worker requires an explicit resolved inference provider (never "auto" or the CLI default)');
    }
    const effort = invocation?.selected?.effort?.value ?? null;
    if (effort === null || !HERMES_DIRECT_EFFORT_VALUES.includes(effort)) {
      throw new Error('Hermes worker requires an explicit qualified --reasoning effort (never a CLI default)');
    }
    const cwd = invocation?.cwd;
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) {
      throw new Error('Hermes worker requires an absolute workspace');
    }
    return ['chat', '--query-file', '-', '--oneshot', '--quiet', '--ignore-user-config', '--ignore-rules', '--source', 'tool',
      '--provider', provider, '-m', model, '--reasoning', effort];
  }

  /**
   * `chat --quiet` prints only the final response text (or nothing, on
   * failure) to stdout; there is no JSON event stream to observe. No
   * stdout event grammar is invented here; the only qualified semantic
   * signal is the session-log framing wired into the shared #2896 observer
   * under `provider: 'hermes'` (tools/ralph-external/lib/worker-health.mjs).
   * @returns {null}
   */
  observeHealthEvent() { return null; }

  /**
   * Candidate (unverified) extraction: non-empty stdout text is a
   * candidate final. This alone is never the truth signal and accepts free
   * text (including the budget-exhaustion warning, module docstring) —
   * see `parseWorkerFinal`, the authoritative gate the installed-module
   * loader also wires.
   * @param {string} stdout
   * @returns {{ response: string } | null}
   */
  parseOutput(stdout) {
    if (typeof stdout !== 'string' || !stdout.trim()) return null;
    return { response: stdout };
  }

  /**
   * Authoritative final-claim gate, wired by the #2885 installed loader
   * alongside `parseOutput` (src/models/worker-installation.mjs:722).
   * Two independent checks, both required, per module docstring:
   *
   *  1. The exit-derived `options.observation.status` must be `'completed'`
   *     (computed by the caller from the owned exit code/termination,
   *     src/serve/worker-invocation.ts / session-launcher.mjs). On 0.21.6
   *     this alone now also rejects the reasoning-budget-exhaustion case
   *     (`agent/turn_truncation.py:95-180`, `partial_result()` sets
   *     `"completed": False, "partial": True`; `_single_query_exit_code`,
   *     `hermes_cli/cli_single_query.py:152-194`, maps that to exit 1 — a
   *     confirmed upstream fix from the 0.20.6 exit-0 bug this check was
   *     originally written against; module docstring). Kept anyway as
   *     defense in depth: Check 2 below is the one that still matters for
   *     a genuinely `completed` turn whose model output is not valid JSON.
   *  2. `output`, after stripping any leading Hermes startup diagnostics
   *     (`stripHermesStartupDiagnostics`, module docstring Fix round 2
   *     #2), must be a valid, strict `workerClaims` JSON document
   *     (`super.parseWorkerFinal` / `ProviderAdapter.parseWorkerOutput`,
   *     `format: 'json'`, #2890). A warning message, an error string, or
   *     any other free text is not a workerClaims document and this
   *     throws — exit 0 is never completion evidence by itself for this
   *     CLI. The stripper only ever removes a diagnostic-shaped prefix: a
   *     diagnostic appearing after the real final, or any unrecognized
   *     preamble, is left in place and still fails this strict parse.
   *
   * @param {string|Uint8Array} output
   * @param {{ observation?: { status?: string, exitCode?: number|null } }} [options]
   * @returns {Promise<import('../../../src/mission-protocol/types.js').WorkerClaims>}
   */
  async parseWorkerFinal(output, options = {}) {
    const status = options?.observation?.status;
    if (status !== 'completed') {
      throw new Error(`Hermes worker did not complete (status: ${status ?? 'unknown'}, exit ${options?.observation?.exitCode ?? 'unknown'})`);
    }
    return super.parseWorkerFinal(stripHermesStartupDiagnostics(output), { ...options, format: 'json' });
  }

  /** No stdin abort channel is evidenced for `chat --oneshot`; cancellation stays with owned process control. */
  getAbortInput() { return null; }
}

/** Installed-module registration: exactly the one approved adapter ID. */
export function register(factory) {
  factory('hermes', () => new HermesAdapter());
}

export default HermesAdapter;
