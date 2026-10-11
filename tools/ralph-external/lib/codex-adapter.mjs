/**
 * Codex CLI Provider Adapter for External Ralph Loop
 *
 * Provides support for OpenAI's Codex CLI as a provider for
 * autonomous task execution in Ralph loops.
 *
 * Codex CLI differences from Claude:
 * - Binary: `codex` instead of `claude`
 * - Headless flag: `--dangerously-bypass-approvals-and-sandbox` (full dangerous mode)
 * - Requires `--skip-git-repo-check` for temp/non-git working directories
 * - No stream-json output format (text only)
 * - No session resume capability
 * - No --agent flag
 * - No --mcp-config flag
 * - No --append-system-prompt flag (inject into main prompt)
 * - No --max-budget-usd flag
 * - Model: generic aliases map to the GPT-5.6 tier ladder (sol / terra / luna)
 *
 * @implements Plan: Multi-Provider Support for External Ralph Loop
 */

import { ProviderAdapter, registerProvider } from './provider-adapter.mjs';
import { classifyWorkerHealthFailure, healthEventMatchesBinding } from './worker-health.mjs';

/**
 * Model mapping from generic names to Codex-specific models.
 *
 * Tier-equivalent mapping (observed in Codex model/list, 2026-09-21):
 * premium = gpt-5.6-sol, standard = gpt-5.6-terra, economy = gpt-5.6-luna.
 * The flagship gpt-6-astra is never selected by an alias; pass it explicitly
 * (e.g., --model gpt-6-astra) when the user elects it.
 */
const MODEL_MAP = {
  'opus':   'gpt-5.6-sol',
  'sonnet': 'gpt-5.6-terra',
  'haiku':  'gpt-5.6-luna',
};

/**
 * Version-bound direct-worker surface (roctinam/aiwg#2897, B-OG-07).
 *
 * Qualified against codex-cli 0.161.0 `--help`/`exec --help` (help/version
 * syntax only, 2026-10-09; never live qualification):
 *
 *   codex --no-daemon exec --ignore-user-config -m M \
 *     -c model_reasoning_effort="E" -s S -C W -c approval_policy="never" \
 *     --skip-git-repo-check -o F --json - < briefPath
 *
 * `--no-daemon` is a root-level flag and `--ignore-user-config` is an
 * `exec`-level flag (root `--help` lists no `--ignore-user-config`;
 * `exec --help` does). `-C/--cd`, `-a/--ask-for-approval` and
 * `-s/--sandbox` are also root-level (there is no `-a` on `exec --help`;
 * approval travels as the `-c approval_policy` override). `-m/--model`
 * is global;
 * `--skip-git-repo-check`, `--json` (JSONL thread/turn/item/error events),
 * `-o/--output-last-message` and `--output-schema` belong to `exec`.
 * `--ignore-user-config` skips `$CODEX_HOME/config.toml`; auth still
 * resolves via `CODEX_HOME` (per root `--help`), so `CODEX_HOME` (or `HOME`
 * for its default location) stays on the env allowlist and nothing else
 * does. `codex mcp-server --help` still prints the root help on 0.161.0, so
 * native MCP stays version-blocked; the AIWG `worker-invoke` bridge remains
 * the MCP route. There is no `--effort` flag: effort travels only as the
 * `-c model_reasoning_effort` config override, emitted as one argv token
 * with TOML `"E"` quoting and no shell layer (`JSON.stringify`, never
 * `'"E"'`). There is no qualified step-cap flag and no per-call subagent
 * disable. The brief travels on stdin (`-` prompt argument, `< briefPath`);
 * it never enters argv, `-c` values or the environment, which also keeps
 * leading-dash briefs out of option parsing.
 *
 * Installed-module shape: static `interfaceVersion` and `register` exports
 * so the #2885 installed loader can approve this file by digest under
 * `installed:codex` (mirroring #2911 openhuman-adapter.mjs). The bottom
 * self-registration targets the legacy Ralph-loop registry only; the direct
 * worker profile loads through the installed loader.
 */
export const CODEX_SUPPORTED_VERSIONS = Object.freeze(['0.161.0']);
export const CODEX_DIRECT_EFFORT_VALUES = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh']);
export const CODEX_DIRECT_SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write']);
/** Non-prompting execution only: a requested `on-request` is refused. */
export const CODEX_DIRECT_APPROVAL_POLICIES = Object.freeze(['never']);
/** Brief transport for the direct profile: piped stdin, never argv. */
export const CODEX_DIRECT_STDIN = 'brief-text';
/** Generic Ralph-loop aliases resolve to the stale gpt-5.6 ladder; the
 * direct profile requires an exact observed API model instead. */
const CODEX_GENERIC_ALIASES = Object.freeze(['opus', 'sonnet', 'haiku']);

/**
 * Summarize one `exec --json` stdout capture: event kinds, correlated
 * thread/turn identities and any model the stream reports. `threadBound`
 * requires `thread.started` plus `turn.started` with a single thread id
 * across all carrying events and every completed turn previously started.
 * `modelMismatch` is true when the stream names a model and the requested
 * pin is not among them (an observed substitution must stop/review, never
 * qualify). Used by the direct-worker conformance tests (CX04b) to detect
 * a model substitution from a real `exec --json` run against the fixture.
 * @param {unknown} stdout
 * @param {unknown} requestedModel
 */
export function summarizeCodexStream(stdout, requestedModel) {
  const kinds = [];
  const threadIds = new Set();
  const startedTurns = new Set();
  const completedTurns = new Set();
  const observedModels = new Set();
  let malformed = 0;
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      continue;
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      malformed += 1;
      continue;
    }
    kinds.push(event.type);
    if (typeof event.thread_id === 'string' && event.thread_id) threadIds.add(event.thread_id);
    if (typeof event.turn_id === 'string' && event.turn_id) {
      if (event.type === 'turn.started') startedTurns.add(event.turn_id);
      if (event.type === 'turn.completed' || event.type === 'turn.failed') completedTurns.add(event.turn_id);
    }
    if (typeof event.model === 'string' && event.model) observedModels.add(event.model);
  }
  const models = [...observedModels];
  return {
    kinds,
    threadIds: [...threadIds],
    startedTurns: [...startedTurns],
    completedTurns: [...completedTurns],
    observedModels: models,
    observedModel: models.length === 1 ? models[0] : null,
    malformed,
    threadBound: kinds.includes('thread.started') && kinds.includes('turn.started')
      && threadIds.size === 1 && [...completedTurns].every(id => startedTurns.has(id)),
    terminalObserved: kinds.includes('turn.completed') || kinds.includes('turn.failed'),
    modelMismatch: models.length > 0 && (typeof requestedModel !== 'string' || !observedModels.has(requestedModel)),
  };
}

export class CodexAdapter extends ProviderAdapter {
  observeHealthEvent(event, source, binding) {
    if (source.kind !== 'stdout' || !event || typeof event !== 'object') return null;
    if (!healthEventMatchesBinding({ sessionId: event.thread_id }, binding)) return null;
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') return { kind: 'setup', sessionId: event.thread_id };
    if (event.type === 'turn.started') return { kind: 'accepted', key: event.turn_id };
    if (event.type === 'item.completed') {
      const item = event.item;
      if (!item || typeof item !== 'object') return null;
      if (item.type === 'error' || item.status === 'failed' || (Number.isInteger(item.exit_code) && item.exit_code !== 0)) {
        return classifyWorkerHealthFailure({ type: 'error', message: item.message }, { source, provider: 'codex' })
          ?? { kind: 'error', reasonCode: 'tool-failed' };
      }
      if (typeof item.id === 'string' && ['agent_message', 'command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(item.type)) {
        return { kind: 'progress', key: item.id };
      }
    }
    if (event.type === 'item.started' || event.type === 'item.updated') return { kind: 'activity' };
    if (event.type === 'turn.completed') return { kind: 'terminal', success: true, key: event.turn_id ?? 'turn.completed' };
    if (event.type === 'error' || event.type === 'turn.failed') {
      // A standalone `error` event fails the run exactly like `turn.failed`:
      // the observer treats fatal errors as non-terminal-proof, so a later
      // `turn.completed` with exit 0 cannot paper over them.
      return { ...classifyWorkerHealthFailure({ type: 'error', message: event.message ?? event.error?.message }, { source, provider: 'codex' }),
        fatal: true };
    }
    return null;
  }
  /** @returns {string} */
  getBinary() {
    return 'codex';
  }

  /** @returns {string} */
  getName() {
    return 'codex';
  }

  /**
   * Codex has limited capabilities compared to Claude.
   * @returns {import('./provider-adapter.mjs').ProviderCapabilities}
   */
  getCapabilities() {
    return {
      streamJson: false,
      sessionResume: false,
      budgetControl: false,
      systemPrompt: false,
      agentMode: false,
      mcpConfig: false,
      maxTurns: false,
    };
  }

  /**
   * Driver-owned argv after the binary for the version-bound direct-shell
   * profile. Every control is explicit: `--ignore-user-config` (user
   * config.toml skipped, auth still via `CODEX_HOME`), exact observed
   * model, explicit effort as one `-c model_reasoning_effort="E"` token
   * (TOML `"E"` quoting via `JSON.stringify`; there is no shell in argv),
   * explicit sandbox/approval (`never` only), the conductor workdir as
   * `-C`, the final file as `-o`, the JSONL event stream as `--json` and
   * `-` as the prompt argument so the brief arrives on stdin
   * (`stdin: 'brief-text'`). Permission flags from the legacy Ralph loop
   * (`--dangerously-bypass-approvals-and-sandbox`), guessed step caps and
   * silent alias/default inheritance are never emitted. The brief is
   * validated here but never placed in argv.
   *
   * @param {{ selected?: { model?: unknown, effort?: { value?: unknown } }, cwd?: unknown, brief?: unknown, finalPath?: unknown }} invocation
   * @param {unknown} _profile
   * @param {{ sandbox?: unknown, approval?: unknown }} [permissions]
   * @returns {string[]}
   */
  buildWorkerArgs(invocation, _profile, permissions) {
    const model = invocation?.selected?.model;
    if (typeof model !== 'string' || !model || model.includes('\0')) {
      throw new Error('Codex worker requires an explicit model');
    }
    if (CODEX_GENERIC_ALIASES.includes(model.toLowerCase())) {
      throw new Error(`Codex worker requires an exact observed model, not the generic alias '${model}'`);
    }
    const effort = invocation?.selected?.effort?.value ?? null;
    if (effort === null || !CODEX_DIRECT_EFFORT_VALUES.includes(effort)) {
      throw new Error('Codex worker requires an explicit qualified effort (never a CLI default)');
    }
    const sandbox = permissions?.sandbox ?? 'workspace-write';
    if (!CODEX_DIRECT_SANDBOX_MODES.includes(sandbox)) {
      throw new Error(`Codex worker sandbox is not a qualified direct mode: ${String(sandbox)}`);
    }
    const approval = permissions?.approval ?? 'never';
    if (!CODEX_DIRECT_APPROVAL_POLICIES.includes(approval)) {
      throw new Error(`Codex worker approval is not a qualified direct policy: ${String(approval)}`);
    }
    const cwd = invocation?.cwd;
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) {
      throw new Error('Codex worker requires an absolute workspace');
    }
    const finalPath = invocation?.finalPath;
    if (typeof finalPath !== 'string' || !finalPath.startsWith('/') || finalPath.includes('\0')) {
      throw new Error('Codex worker requires an absolute final-output path');
    }
    const brief = invocation?.brief;
    if (typeof brief !== 'string' || !brief || brief.includes('\0')) {
      throw new Error('Codex worker requires a non-empty brief');
    }
    return [
      '--no-daemon',
      'exec',
      '--ignore-user-config',
      '-m', model,
      '-c', `model_reasoning_effort=${JSON.stringify(effort)}`,
      '-s', sandbox,
      '-C', cwd,
      '-c', `approval_policy=${JSON.stringify(approval)}`,
      '--skip-git-repo-check',
      '-o', finalPath,
      '--json',
      '-',
    ];
  }

  /**
   * `exec --json` has no stdin abort channel and stdin carries the brief to
   * EOF, so cancellation stays with owned process control.
   * @returns {null}
   */
  getAbortInput() {
    return null;
  }

  /**
   * Build args for the main headless session.
   *
   * Codex uses `--full-auto` for headless operation and has a different
   * argument structure than Claude.
   *
   * @param {import('./provider-adapter.mjs').SessionArgs} options
   * @returns {string[]}
   */
  buildSessionArgs(options) {
    const args = [
      // Codex requires the 'exec' subcommand for non-interactive (headless) use.
      'exec',
      // SECURITY: bypass ALL confirmation prompts and sandboxing.
      // Required for headless operation in temp directories (UAT, daemon tasks).
      // Equivalent to Claude's --dangerously-skip-permissions.
      '--dangerously-bypass-approvals-and-sandbox',
      // Allow running outside a git repository (temp dirs used by UAT and daemon).
      '--skip-git-repo-check',
    ];

    // Model selection (map generic to Codex-specific)
    if (options.model) {
      args.push('--model', this.mapModel(options.model));
    }

    // Budget control not supported - warn if requested
    if (options.budget) {
      this.warnUnsupported('budgetControl', 'Budget control (--max-budget-usd)');
    }

    // Max turns not supported
    if (options.maxTurns) {
      this.warnUnsupported('maxTurns', 'Max turns (--max-turns)');
    }

    // Session ID not supported - each iteration is a fresh session
    if (options.sessionId) {
      this.warnUnsupported('sessionResume', 'Session resume (--session-id)');
    }

    // MCP configuration not supported
    if (options.mcpConfig) {
      this.warnUnsupported('mcpConfig', 'MCP configuration (--mcp-config)');
    }

    // System prompt: Codex doesn't support --append-system-prompt,
    // so we prepend it to the main prompt
    let prompt = options.prompt;
    if (options.systemPrompt) {
      prompt = `[System Context]\n${options.systemPrompt}\n\n[Task]\n${prompt}`;
    }

    // The prompt itself (must be last)
    args.push(prompt);

    return args;
  }

  /**
   * Build args for short analysis calls (spawnSync).
   *
   * Codex analysis calls use the same basic pattern but with
   * Codex-specific flags.
   *
   * @param {import('./provider-adapter.mjs').AnalysisArgs} options
   * @returns {string[]}
   */
  buildAnalysisArgs(options) {
    const args = [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
    ];

    // Model selection
    if (options.model) {
      args.push('--model', this.mapModel(options.model));
    }

    // Agent flag not supported by Codex - inject agent context into prompt
    if (options.agent) {
      // Silently skip - agent context will be in the prompt itself
    }

    // The analysis prompt (must be last)
    args.push(options.prompt);

    return args;
  }

  /**
   * Map generic model names to Codex-specific models.
   *
   * Mirrors the catalog roles used by tools/agents/providers/codex.mjs:
   *   opus → gpt-5.6-sol
   *   sonnet → gpt-5.6-terra
   *   haiku → gpt-5.6-luna
   *
   * @param {string} genericModel
   * @returns {string}
   */
  mapModel(genericModel) {
    const mapped = MODEL_MAP[genericModel.toLowerCase()];
    if (mapped) return mapped;
    // Pass through if already a Codex model name or unknown
    return genericModel;
  }

  /**
   * Environment overrides for headless Codex sessions.
   * @returns {Object<string, string>}
   */
  getEnvOverrides() {
    return {
      CI: 'true',
    };
  }

  /**
   * Codex does not store session transcripts in a known location.
   * @returns {null}
   */
  getTranscriptPath() {
    return null;
  }

  /**
   * Parse Codex output - Codex returns plain text, not stream-json.
   * We still try to extract JSON from the output for analysis results.
   *
   * @param {string} stdout
   * @returns {Object|null}
   */
  parseOutput(stdout) {
    // Codex output is plain text. Try to find embedded JSON.
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
}

// Self-register on import for the legacy Ralph loop only. The direct worker
// profile loads through the #2885 installed loader instead (see below).
registerProvider('codex', () => new CodexAdapter());

/** Installed-module interface version (mirrors #2911 openhuman-adapter.mjs). */
export const interfaceVersion = 1;

/** Installed-module registration: exactly the one approved adapter ID. */
export function register(factory) {
  factory('codex', () => new CodexAdapter());
}

export default CodexAdapter;
