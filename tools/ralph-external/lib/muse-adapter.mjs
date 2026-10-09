/**
 * Muse Code (`muse`) provider adapter for headless External Ralph sessions.
 *
 * Drives `muse exec` — Meta's documented headless surface — with JSONL events
 * (`--json`), headless resume (`--session-id`), and transcript/export
 * (`muse export`) support. Optional and post-experimental per
 * `docs/architecture/adr-muse-provider-target.md` ("Headless Ralph"): no
 * `muse exec` contract is assumed beyond what is evidenced below, and the
 * adapter disables entirely via `AIWG_MUSE_RALPH_ENABLED=0` without affecting
 * `aiwg use --provider muse` (the deploy/writer path lives in `src/` and
 * never consults this registry).
 *
 * Flag evidence (all Meta docs at https://dev.meta.ai/docs/muse-code/
 * unless noted):
 *   - `muse exec [OPTIONS] [PROMPT]` — headless entrypoint; "takes one
 *     prompt, runs it to completion, and exits" (extending). The prompt is
 *     positional and must come last. Options are parsed by `exec`, not by
 *     the `muse` root — flags placed before the sub-command are silently
 *     ignored — so every adapter-built argv starts with `exec`.
 *   - `--json` — "emit JSONL events" (extending; configuration lists it as
 *     headless-only).
 *   - `--prompt-file <path>` — headless-only (configuration).
 *   - `--max-model-steps <n>` — headless-only, "cap the run" (configuration).
 *   - `--session-id <uuid>` — "To continue an interrupted job
 *     non-interactively, use `exec` with the session id":
 *     `muse exec --session-id <uuid> "Continue the task."` (extending).
 *     There is no headless resume flag; re-passing the id continues the
 *     session. `muse resume` is interactive-only.
 *   - `--model <id>`, `--reasoning-effort <level>` — common to both launch
 *     surfaces (configuration).
 *   - `--approval-mode <mode>` — common to both; "`muse exec` accepts both
 *     approval flags" (configuration). Opt-in only: the adapter sets NO
 *     approval posture by default (#230 out of scope: `--yolo` defaults).
 *   - `muse export --session <uuid> --out <path>` — offline,
 *     byte-deterministic transcript projection; `--last` and `--redacted`
 *     skip the picker / redact payload strings (cookbook:
 *     audit-agent-sessions). Export "never modifies the log".
 *   - Exit codes: 0 = turn completes, 1 = fails or is cancelled (including a
 *     `--max-model-steps` limit), 2 = usage error, 130/143 on SIGINT/SIGTERM
 *     (extending).
 *   - Sandbox: Muse Code ships an OS-enforced sandbox (bubblewrap/seccomp +
 *     namespaces on Linux, seatbelt on macOS) that is ON by default; `--yolo`
 *     disables approval AND sandboxing — "use it only on trusted code in a
 *     disposable, isolated container" (extending). The adapter never passes
 *     `--yolo`. See docs/providers/muse-ralph-exec.md for the CI sandbox
 *     (bubblewrap/user-namespace) requirements this implies.
 *
 * Verified against an installed Muse Code 1.4.0 (2026-09-25):
 *   - `--json` emits one record envelope per line: `{schema_version, id,
 *     stream, sequence, recorded_at, record_type, durability, causation_id,
 *     payload_type, payload_schema_version, payload}` — the same envelope as
 *     the native session log. `run.output.delta` carries streamed `text`;
 *     the run ends with `run.terminal.<state>` whose payload carries
 *     `terminal` (`completed`/`failed`), the final `text`, and a `reason`
 *     on failure. `parseOutput()` reads exactly those fields.
 *   - Exit codes 0 (completed), 1 (run failed, e.g. an unknown model:
 *     "model `x` does not exist or you lack access"), 2 (usage error).
 *   - `--session-id <uuid>` pins the new session's id (the native log lands
 *     in `$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<uuid>/`), and re-passing
 *     the same id continues that session with its context.
 *   - A prompt starting with `-` is parsed as an option (exit 2) unless it
 *     follows `--`, so the positional prompt is always preceded by `--`.
 *   - Plain mode (no `--json`) prints only the final answer text on stdout.
 *
 * Not assumed:
 *   - Transcript paths. The native log root is evidenced, but its layout is
 *     internal (retained frames, omission markers), so `getTranscriptPath()`
 *     returns null and transcripts come from `muse export`, the documented
 *     projection.
 *   - A pinned CLI version. Unlike pi, no qualified-version list exists yet;
 *     `isAvailable()` checks only that `muse --version` exits 0.
 *
 * @issue #230
 */

import { ProviderAdapter, registerProvider } from './provider-adapter.mjs';
import { classifyWorkerHealthFailure, healthEventMatchesBinding } from './worker-health.mjs';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const museEffortValues = JSON.parse(readFileSync(new URL('../../../agentic/code/providers/model-capabilities.v1.json', import.meta.url), 'utf8')).providers.muse.effortValues;

// Syntax inspected only; neither help nor echo qualifies authenticated execution.
export const MUSE_DIRECT_VERSION = '1.4.4-R5419.1';

/** Quota observations are candidates, not a retry/admission decision. Unknown
 * scope/reset stay null; the caller binds the account/quota domain separately. */
export function museQuotaEvidence(payload) {
  const failure = classifyWorkerHealthFailure({ type: 'error', message: payload?.reason }, { provider: 'muse' });
  if (failure?.reasonCode !== 'RATE_LIMIT') return null;
  const text = typeof payload.reason === 'string' ? payload.reason : '';
  const reset = typeof payload.reset_at === 'string' ? payload.reset_at
    : /reset(?:[_ -]at)?["\s:=]+(\d{4}-\d\d-\d\dT[\d:.]+Z)/i.exec(text)?.[1];
  return { reasonCode: failure.reasonCode,
    quotaScope: typeof payload.quota_scope === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(payload.quota_scope) ? payload.quota_scope : null,
    resetAt: reset && Number.isFinite(Date.parse(reset)) ? new Date(reset).toISOString() : null,
    retryAfterSeconds: failure.retryAfterSeconds ?? null };
}

/**
 * Whether the muse exec Ralph adapter is registered. Enabled by default;
 * set `AIWG_MUSE_RALPH_ENABLED` to `0`, `false`, `no`, or `off` to disable
 * the adapter without affecting `aiwg use --provider muse`.
 *
 * @returns {boolean}
 */
export function isMuseRalphEnabled() {
  const raw = String(process.env.AIWG_MUSE_RALPH_ENABLED ?? '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

export class MuseAdapter extends ProviderAdapter {
  observeHealthEvent(event, source, binding) {
    if (source.kind === 'stderr' || !event || typeof event !== 'object' || event.record_type !== 'event') return null;
    if (event.stream?.kind !== 'session' || typeof event.stream.id !== 'string') return null;
    const payload = event.payload;
    if (!payload || typeof payload !== 'object' || typeof payload.run_id !== 'string' || !payload.run_id) return null;
    if (!healthEventMatchesBinding({ sessionId: event.stream.id, runId: payload.run_id }, binding)) return null;
    // Native session records require an already bound session and run. Reading
    // a log from the same provider does not authorize unrelated session traffic.
    if (source.kind === 'session-log' && (!binding.sessionId || event.stream.id !== binding.sessionId
      || !binding.runId || payload.run_id !== binding.runId)) return null;
    if (event.payload_type === 'run.lifecycle.started' && payload.kind === 'run_started') {
      return { kind: 'accepted', sessionId: event.stream.id, runId: payload.run_id, key: event.id };
    }
    // A terminal/delta cannot establish a new session/run binding.
    if (!binding.sessionId || !binding.runId) return null;
    if (event.payload_type === 'run.output.delta' && payload.kind === 'run_output_delta' && typeof payload.text === 'string') {
      return { kind: 'activity', key: event.id };
    }
    if (event.payload_type === 'run.terminal.completed' && payload.kind === 'run_terminal' && payload.terminal === 'completed') {
      return { kind: 'terminal', success: true, key: event.id };
    }
    if (event.payload_type === 'run.terminal.failed' && payload.kind === 'run_terminal' && payload.terminal === 'failed') {
      return { ...classifyWorkerHealthFailure({ type: 'error', message: payload.reason }, { source, provider: 'muse' }),
        ...museQuotaEvidence(payload), fatal: true };
    }
    return null;
  }
  getBinary() {
    return process.env.AIWG_MUSE_BIN || 'muse';
  }

  getName() {
    return 'muse';
  }

  /** Direct group path, separate from legacy session defaults. Policy is checked
   * by resolveWorkerPlan/prepareWorkerInvocation, including contributor/ultra
   * denial. Never map an explicit model away or fall back to a CLI default.
   * The host binds the schema's absolute path in the existing control mapping
   * and includes its bytes in installation.runtimeFiles for qualification. */
  buildWorkerArgs(invocation, profile, permissions) {
    const { selected, cwd, briefPath, health } = invocation;
    const model = selected?.model, effort = selected?.effort?.value;
    if (typeof model !== 'string' || !model || model.includes('\0')) throw new Error('Muse requires an explicit resolved model');
    if (typeof effort !== 'string' || !museEffortValues.includes(effort)) throw new Error('Muse requires a declared explicit resolved effort');
    for (const value of [cwd, briefPath]) {
      if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || value.split(path.sep).includes('..')) {
        throw new Error('Muse requires absolute workspace and prompt-file paths');
      }
    }
    let schema;
    try { schema = JSON.parse(profile.controls.structuredOutput.mapping); } catch { /* unavailable mapping blocks */ }
    if (!Array.isArray(schema) || schema.length !== 2 || schema[0] !== '--output-schema'
      || typeof schema[1] !== 'string' || !path.isAbsolute(schema[1]) || schema[1].includes('\0') || schema[1].split(path.sep).includes('..')) {
      throw new Error('Muse requires a host-bound output-schema control mapping');
    }
    if (!permissions || !['read-only', 'workspace-write', 'external'].includes(permissions.sandbox)
      || !Number.isSafeInteger(health?.maxSteps) || health.maxSteps < 1) throw new Error('Muse requires bounded steps and sandbox authority');
    // Trust is a host-owned, qualification-bound control, like the schema.
    // Brief contents and CLI defaults cannot opt into workspace instructions.
    let trust;
    try { trust = JSON.parse(profile.controls.trust.mapping); } catch { /* fail closed below */ }
    if (!Array.isArray(trust) || !(trust.length === 0 || trust.length === 1 && trust[0] === '--trust-workspace')) {
      throw new Error('Muse requires an explicit host-controlled workspace trust mapping');
    }
    const args = ['exec', '--json', '--provider', 'meta', '--model', model, '--reasoning-effort', effort,
      '--workspace', cwd, ...trust, '--approval-mode', 'never', '--approval-judge', 'off', '--max-model-steps', String(health.maxSteps),
      ...schema, '--prompt-file', briefPath];
    if (permissions.sandbox === 'read-only') args.push('--disable-write', '--disable-shell');
    return args;
  }

  getCapabilities() {
    return {
      streamJson: true, // --json (evidenced: JSONL events on stdout)
      sessionResume: true, // --session-id (evidenced: headless resume)
      budgetControl: false, // no --max-budget-usd equivalent documented
      systemPrompt: false, // no --append-system-prompt documented for exec
      agentMode: false, // no --agent flag documented
      mcpConfig: false, // MCP lives in ~/.config/muse/settings.json; no exec flag
      // maxTurns maps to --max-model-steps (evidenced, headless-only); the
      // capability name follows the base-class contract, the argv does not
      // invent a --max-turns flag muse would reject with exit code 2.
      maxTurns: true,
    };
  }

  /**
   * Build argv for a headless session: `muse exec [OPTIONS] [PROMPT]`.
   * The prompt is positional and always last (evidenced). No approval
   * posture is set unless the caller opts in via `approvalMode` — `--yolo`
   * is never emitted (#230 out of scope).
   *
   * @param {import('./provider-adapter.mjs').SessionArgs & {
   *   reasoningEffort?: string, approvalMode?: string, promptFile?: string
   * }} options
   * @returns {string[]}
   */
  buildSessionArgs(options, { json = true } = {}) {
    // Sub-command-first: options are parsed by `exec`, never by the root.
    const args = json ? ['exec', '--json'] : ['exec'];

    // Session pin / headless resume (evidenced).
    if (options.sessionId) args.push('--session-id', options.sessionId);

    // Model and reasoning depth (evidenced, common to both surfaces).
    const model = options.model ? this.mapModel(options.model) : null;
    if (model) args.push('--model', model);
    if (options.reasoningEffort) args.push('--reasoning-effort', options.reasoningEffort);

    // Step cap (evidenced, headless-only). The capability is `maxTurns`;
    // muse's flag is --max-model-steps, so translate rather than warn.
    if (options.maxTurns) args.push('--max-model-steps', String(options.maxTurns));

    // Approval posture is operator opt-in only (evidenced flag, no default).
    if (options.approvalMode) args.push('--approval-mode', options.approvalMode);

    if (options.budget) this.warnUnsupported('budgetControl', 'Budget control');
    if (options.systemPrompt) this.warnUnsupported('systemPrompt', 'System prompt');
    if (options.agent) this.warnUnsupported('agentMode', 'Agent mode');
    if (options.mcpConfig) this.warnUnsupported('mcpConfig', 'MCP configuration');

    if (options.promptFile) {
      args.push('--prompt-file', options.promptFile);
    } else {
      // The prompt itself (positional, must be last). `--` stops option
      // parsing so a prompt that starts with `-` is not read as a flag.
      args.push('--', options.prompt);
    }

    return args;
  }

  /**
   * Build argv for short analysis calls (spawnSync). Same headless surface
   * as sessions, but without `--json`: analysis consumers parse the reply
   * text, and `parseOutput()` extracts no text from JSONL events.
   *
   * @param {import('./provider-adapter.mjs').AnalysisArgs} options
   * @returns {string[]}
   */
  buildAnalysisArgs(options) {
    return this.buildSessionArgs(options, { json: false });
  }

  /**
   * Build argv for the transcript/export path: `muse export`.
   * Offline and byte-deterministic per Meta docs; never modifies the log.
   *
   * @param {{ sessionId?: string, out?: string, redacted?: boolean, last?: boolean }} options
   * @returns {string[]}
   */
  buildExportArgs(options = {}) {
    const args = ['export'];
    if (options.last) {
      args.push('--last');
    } else if (options.sessionId) {
      args.push('--session', options.sessionId);
    }
    if (options.redacted) args.push('--redacted');
    if (options.out) args.push('--out', options.out);
    return args;
  }

  /**
   * The CLI accepts `--model <id>` with a Meta provider catalog id
   * (observed: `muse-spark-1.3`, the current model, plus
   * `muse-spark-1.3-contributor`, `muse-spark-1.2`, and
   * `muse-spark-1.2-contributor`). Only Muse ids pass through. Generic or
   * other-provider names (Ralph defaults to Claude names) map to null so no
   * `--model` flag is emitted and muse uses its configured default.
   *
   * @param {string} genericModel
   * @returns {string|null}
   */
  mapModel(genericModel) {
    return /^muse-/i.test(genericModel) ? genericModel : null;
  }

  getEnvOverrides() {
    return { CI: 'true', NO_COLOR: '1' };
  }

  /** No evidenced stdin command channel for `muse exec`; no abort frame. */
  getAbortInput() {
    return null;
  }

  /**
   * ADR fail-closed path policy: no native session-log root is assumed, so
   * there is no transcript path to return. Use `buildExportArgs()` to
   * produce a `muse export` document instead.
   *
   * @returns {null}
   */
  getTranscriptPath() {
    return null;
  }

  /**
   * Parse `muse exec --json` output. Returns the events, the final answer
   * text, and settlement from the `run.terminal.<state>` record: `settled`
   * is true only for `completed`, false for any other terminal state, and
   * null when the stream ended without a terminal record. One malformed
   * line rejects the whole stream (fail closed).
   *
   * @param {string} stdout
   * @returns {{ events: object[], text: string|null, settled: boolean|null,
   *   terminal: string|null, reason: string|null } | null}
   */
  parseOutput(stdout) {
    if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 10485760) return null;
    const events = [];
    for (const raw of stdout.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        return null;
      }
    }
    if (!events.length) return null;
    let deltas = '';
    let terminal = null;
    for (const event of events) {
      const type = typeof event?.payload_type === 'string' ? event.payload_type : '';
      const payload = event?.payload ?? {};
      if (type === 'run.output.delta' && typeof payload.text === 'string') deltas += payload.text;
      if (terminal) return null; // double final or output after terminal
      if (type.startsWith('run.terminal.')) {
        if (!['run.terminal.completed', 'run.terminal.failed'].includes(type)
          || payload.terminal !== type.slice('run.terminal.'.length)) return null;
        terminal = payload;
      }
    }
    const state = typeof terminal?.terminal === 'string' ? terminal.terminal : null;
    const finalText = typeof terminal?.text === 'string' && terminal.text ? terminal.text : deltas;
    return {
      events,
      text: finalText || null,
      settled: state === null ? null : state === 'completed',
      terminal: state,
      reason: typeof terminal?.reason === 'string' ? terminal.reason : null,
      ...(terminal && museQuotaEvidence(terminal) ? { quota: museQuotaEvidence(terminal) } : {}),
    };
  }
}

registerProvider('muse', () => new MuseAdapter());

export default MuseAdapter;
