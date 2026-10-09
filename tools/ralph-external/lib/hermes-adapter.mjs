/**
 * Hermes direct-worker driver (B-OG-48, roctinam/aiwg#2912).
 *
 * Baseline: `hermes chat --query-file - --oneshot --quiet --ignore-user-config
 * -m MODEL --reasoning LEVEL`, verified against the installed `hermes 0.20.6`
 * `hermes chat --help` and installed `hermes_cli` source (never run with a
 * prompt):
 *
 *  - `--query-file -` reads the single query from stdin to EOF, with nothing
 *    shell-interpreted (`hermes_cli/_parser.py:352-365` flag text; dispatched
 *    at `hermes_cli/main.py:3443-3454`: `if _qfile == "-": args.query =
 *    sys.stdin.read()`). The brief never enters argv.
 *  - `--oneshot` (dest `oneshot_exit`, `_parser.py:368-384`) answers the
 *    query and exits instead of seeding an interactive session.
 *  - `-Q/--quiet` (`_parser.py:447-451`) is the "quiet mode for programmatic
 *    use" branch (`cli.py:22062` `if quiet:`): stdout carries only
 *    `print(response)` when the turn produced text — no banner, no
 *    `session_id:` line (that goes to stderr, `cli.py:22200`).
 *  - `-m/--model` and `--reasoning LEVEL` are declared directly on the
 *    `chat` subparser (`_parser.py:400-420`).
 *  - `--ignore-user-config` (`_parser.py`, `chat --help`: "Ignore
 *    ~/.hermes/config.yaml and fall back to built-in defaults (credentials
 *    in .env are still loaded)") pins every approval-policy setting to the
 *    SAFE built-in default regardless of the host's config file — see
 *    "Approval policy is NOT emitted-flag-only" below. Session/auth
 *    credentials still resolve via `.env`, so this never blocks dispatch.
 *
 * EXIT CODE IS NOT SUFFICIENT EVIDENCE OF COMPLETION. Two distinct,
 * source-confirmed cases make exit 0 insufficient on its own:
 *
 *  1. A turn that produced partial text before `result["failed"] = True`
 *     still prints that text (`cli.py`'s `elif response: print(response)`
 *     runs regardless of `failed`) and correctly exits 1
 *     (`cli.py:22209-22223`, `_exit_code = 1 if result.get("failed") else
 *     0`). This part chat gets right (unlike `-z`, see below).
 *  2. Reasoning-budget exhaustion. `agent/conversation_loop.py:3902`
 *     returns `{"final_response": "⚠️ **Thinking Budget Exhausted**...",
 *     "completed": False, "partial": True, "error": "...", }` with **no
 *     `"failed"` key at all** (not merely `False` — absent). `response` is
 *     non-empty (the warning text), so `cli.py` prints it to stdout via
 *     `elif response: print(response)`, and since `result.get("failed")`
 *     is `None` (falsy), `_exit_code` stays `0`. **Exit 0, non-empty
 *     stdout, genuinely incomplete.** This is why `parseWorkerFinal` below
 *     does not stop at the exit-derived `status`: it also requires the
 *     final text to be a valid, strict `workerClaims` JSON document
 *     (#2890's `ProviderAdapter.parseWorkerFinal`/`parseWorkerOutput`,
 *     `format: 'json'`). A warning message, an error string, or any other
 *     free text is not a workerClaims document and fails that parse
 *     regardless of exit code.
 *
 * APPROVAL POLICY IS NOT EMITTED-FLAG-ONLY. `hermes chat -q/--query-file`
 * sessions set `HERMES_SINGLE_QUERY_SESSION=1` (`cli.py:22010-22021`),
 * routing any tool-approval gate through `approvals.single_query_mode`
 * — but that setting, and the sibling `approvals.mode`, are **host config**
 * (`~/.hermes/config.yaml`), not argv:
 *
 *  - `tools/approval.py:3552` (`_get_single_query_approval_mode()`) accepts
 *    `approve/off/allow/yes` as a config value and treats any of them as
 *    "approve" (auto-approve, logged at `tools/approval.py:3856`). The
 *    BUILT-IN DEFAULT is `"deny"` (`hermes_cli/config_defaults.py:2559`),
 *    but an operator's `config.yaml` can set `single_query_mode: approve`.
 *  - `approvals.mode` (default `"smart"`, `config_defaults.py:2519`) can be
 *    set to `"off"` in config.yaml, which bypasses approval prompts the
 *    same way `--yolo` does (`tools/approval.py:4778`,`5475`).
 *  - `HERMES_YOLO_MODE` is a process env var, frozen at Python import time
 *    (`tools/approval.py:37`, `_YOLO_MODE_FROZEN =
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
 * -ignore-user-config override is real and evidenced, but it is read from
 * source, not from a live run.
 *
 * `-z` is intentionally NOT used as the baseline. Reading the installed
 * source (never running it) shows invariants it cannot meet that
 * `chat --query-file - --oneshot --quiet` does meet: `-z PROMPT`
 * (`hermes_cli/_parser.py:153-162`) takes the brief as a plain positional
 * value with no stdin/file alternative, and `hermes_cli/oneshot.py`
 * unconditionally sets `HERMES_YOLO_MODE=1`/`HERMES_ACCEPT_HOOKS`
 * (docstring + line 255-256) with no disabling flag at all (not even
 * `--ignore-user-config` — that flag is top-level/`chat`-only in its
 * approval-relevant effect; `-z`'s YOLO env-var set happens unconditionally
 * in Python before any config is consulted).
 *
 * There is no `--usage-file`/JSON-usage equivalent for `chat`: that flag is
 * read only by the top-level `-z` dispatch sites
 * (`hermes_cli/main.py:12729,12787,14784`). Final-output extraction for
 * this profile is stdout text on exit 0 PLUS a strict workerClaims parse,
 * never exit code alone.
 *
 * Installed-module shape: static `interfaceVersion` and `register` exports
 * so the #2885 loader can approve this file by digest under
 * `installed:hermes` (mirrors #2911 openhuman-adapter.mjs). Hermes has no
 * qualified Ralph-loop session (no stream-json, no resume contract
 * evidenced for this profile), so `buildSessionArgs` throws like
 * OpenHuman's. Extends `ProviderAdapter` (like the Codex profile) so
 * `parseWorkerFinal` can delegate to the shared strict `workerClaims`
 * parser via `super.parseWorkerFinal`.
 */
import { ProviderAdapter } from './provider-adapter.mjs';

export const interfaceVersion = 1;

export const HERMES_SUPPORTED_VERSIONS = Object.freeze(['0.20.6']);
/** `--reasoning LEVEL`, `hermes chat --help`, minus the shared resolver's denied `ultra`. */
export const HERMES_DIRECT_EFFORT_VALUES = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

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
   * --quiet --ignore-user-config -m <model> --reasoning <effort>`. The
   * brief never enters argv (it travels on stdin via `--query-file -`).
   * `--ignore-user-config` is always emitted: it pins `approvals.mode`/
   * `single_query_mode` to their safe built-in defaults regardless of the
   * host's config.yaml (see module docstring). No sandbox/approval flag is
   * invented beyond that — there is no such flag on this CLI.
   *
   * @param {{ selected?: { model?: unknown, effort?: { value?: unknown } }, cwd?: unknown, brief?: unknown }} invocation
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
    const effort = invocation?.selected?.effort?.value ?? null;
    if (effort === null || !HERMES_DIRECT_EFFORT_VALUES.includes(effort)) {
      throw new Error('Hermes worker requires an explicit qualified --reasoning effort (never a CLI default)');
    }
    const cwd = invocation?.cwd;
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) {
      throw new Error('Hermes worker requires an absolute workspace');
    }
    return ['chat', '--query-file', '-', '--oneshot', '--quiet', '--ignore-user-config', '--ignore-rules', '--source', 'tool', '-m', model, '--reasoning', effort];
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
   *     src/serve/worker-invocation.ts / session-launcher.mjs). This alone
   *     rejects a failed exit code, but NOT the budget-exhaustion case
   *     (exit 0, non-empty free text, `completed: false` on the Hermes
   *     side — `agent/conversation_loop.py:3902`).
   *  2. `output` must be a valid, strict `workerClaims` JSON document
   *     (`super.parseWorkerFinal` / `ProviderAdapter.parseWorkerOutput`,
   *     `format: 'json'`, #2890). A warning message, an error string, or
   *     any other free text is not a workerClaims document and this
   *     throws — exit 0 is never completion evidence by itself for this
   *     CLI.
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
    return super.parseWorkerFinal(output, { ...options, format: 'json' });
  }

  /** No stdin abort channel is evidenced for `chat --oneshot`; cancellation stays with owned process control. */
  getAbortInput() { return null; }
}

/** Installed-module registration: exactly the one approved adapter ID. */
export function register(factory) {
  factory('hermes', () => new HermesAdapter());
}

export default HermesAdapter;
