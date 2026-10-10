/** Pi Coding Agent adapter for headless External Ralph sessions. */
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { ProviderAdapter, registerProvider } from './provider-adapter.mjs';
import { healthEventMatchesBinding } from './worker-health.mjs';

/**
 * Version-bound direct-worker surface (roctinam/aiwg#2910, B-OG-45).
 *
 * Qualified against pi 1.1.0 `--help` (help/version syntax only,
 * 2026-10-09; never live qualification; upgraded from the originally
 * qualified 0.87.1 -- the `--help` diff at
 * `.aiwg/working/s1-scratch/cli-help/pi-diff.txt` shows every flag this
 * profile emits is unchanged, plus a new `--no-mcp`):
 *
 *   pi --mode json --no-approve --no-context-files --no-extensions \
 *     --no-skills --no-mcp --model M --thinking E < briefPath
 *
 * `--mode json` forces non-interactive JSONL output regardless of TTY or
 * `--print` (installed pi 1.1.0 bundle, `resolveAppMode()`: `parsed.mode
 * === "json"` short-circuits to `"json"` before any print/interactive
 * check), so no separate `-p/--print` flag is needed. `--no-approve`
 * ("Ignore project-local files for this run") alone is NOT a complete
 * isolation boundary: it sets project trust to false but does not stop
 * context loading. The installed pi 1.1.0 bundle (`chunk-OIM2DMFI.js`,
 * static read 2026-10-09: `agentsFiles = this.noContextFiles ? [] :
 * loadProjectContextFiles(...)`) loads ancestor `AGENTS.md`/`CLAUDE.md`
 * files independently of trust unless `noContextFiles` is set. The direct
 * profile therefore also emits `--no-context-files`
 * (`-nc`, "Disable AGENTS.md and CLAUDE.md discovery and loading"),
 * `--no-extensions` (`-ne`) and `--no-skills` (`-ns`) -- the same discovery
 * surfaces OMP's profile disables -- so no untrusted workspace file
 * (context, extension or skill) is ever loaded into the worker. 1.1.0
 * adds built-in MCP support, on by default; the direct profile also emits
 * `--no-mcp` ("Disable built-in MCP support: no servers connect and no
 * MCP tools", `pi --help`) for the same reason -- an unvetted MCP server
 * configuration is an untrusted-workspace surface like
 * extensions/skills, and the AIWG `worker-invoke` bridge remains the one
 * MCP route. The direct profile never emits `--approve` ("Trust
 * project-local files for this run"). There is no documented sandbox,
 * approval-prompt, output-file, output-schema, step-cap or child-denial
 * flag (`pi --help`, 2026-10-09): those controls stay unavailable rather
 * than invented, and the final answer is extracted from the stdout JSONL
 * stream (`parseOutput()`), never a `-o`-style file. There is no
 * `--cwd`/`-C` flag either; the launcher's shell `cd` to the workspace is
 * the only workdir binding. The brief travels on stdin, never argv:
 * installed pi 1.1.0 bundle (`chunk-OIM2DMFI.js`, `readPipedStdin()` /
 * `buildInitialMessage()`, static read 2026-10-09, byte-identical to the
 * 0.87.1 evidence) shows piped, non-TTY stdin is trimmed and becomes the
 * sole initial-message part whenever no positional message/file argument
 * is given, so omitting the positional message and piping the brief is
 * sufficient -- and an all-whitespace brief would trim to nothing and
 * must never be sent.
 */
export const PI_DIRECT_VERSION = '1.1.0';
/** Mirrors providers.pi.effortValues in model-capabilities.v1.json (hardcoded,
 * not read via a repo-relative path: the installed-module loader copies this
 * file to an arbitrary package root, so import.meta.url-relative reads to the
 * repository are not safe here). */
export const PI_DIRECT_EFFORT_VALUES = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh']);
/** Brief transport for the direct profile: piped stdin, never argv. */
export const PI_DIRECT_STDIN = 'brief-text';

/**
 * Pi CLI versions this adapter is qualified against. `isAvailable()` fails
 * closed outside this list (#2550): Pi's `--mode json` contract (stdin
 * handling, JSONL framing, `agent_settled`) is verified per version by
 * `npm run smoke:pi:live`, and an unqualified release must not be driven by
 * an unattended loop on the strength of `pi --version` exiting 0.
 */
export const PI_SUPPORTED_VERSIONS = Object.freeze(['0.85.0']);

export function normalizePiVersion(version) {
  return String(version ?? '').trim().replace(/^pi\s+/i, '').replace(/^v/, '');
}

export function isSupportedPiVersion(version) {
  return PI_SUPPORTED_VERSIONS.includes(normalizePiVersion(version));
}

export class PiAdapter extends ProviderAdapter {
  observeHealthEvent(event, source, binding) {
    if (source.kind !== 'stdout' || !event || typeof event !== 'object') return null;
    if (!healthEventMatchesBinding({ sessionId: event.sessionId ?? (event.type === 'session' ? event.id : undefined) }, binding)) return null;
    if (event.type === 'session') return { kind: 'setup', sessionId: event.id };
    if (event.type === 'agent_start') return { kind: 'accepted' };
    if (event.type === 'agent_end') {
      if (event.willRetry === true || (Array.isArray(event.messages) && event.messages.some(message => message.stopReason === 'error' || message.stopReason === 'aborted'))) {
        return { kind: 'error', reasonCode: 'provider-failed' };
      }
      // agent_end can precede retry/continuation: settlement requires Pi's
      // own agent_settled event. Completed output can still be progress.
      if (Array.isArray(event.messages) && event.messages.some(message => message.role === 'assistant')) {
        return { kind: 'progress', key: JSON.stringify(event.messages) };
      }
      return { kind: 'activity' };
    }
    if (event.type === 'agent_settled') return { kind: 'terminal', success: true, key: 'agent_settled' };
    return null;
  }
  getBinary() { return process.env.AIWG_PI_BIN || 'pi'; }
  getName() { return 'pi'; }
  getCapabilities() {
    // rpcAbort is false on purpose. Pi 0.85.0 reads stdin commands only in
    // `--mode rpc`; in `--mode json` it reads piped stdin as prompt text and
    // blocks until EOF (readPipedStdin in dist/main.js). Opening a stdin pipe
    // to send an abort frame therefore keeps the session from ever starting,
    // so the launcher must leave stdin closed and cancel with the bounded
    // TERM/KILL path (#2550).
    return { streamJson: true, sessionResume: true, budgetControl: false,
      systemPrompt: true, agentMode: false, mcpConfig: false, maxTurns: false,
      rpcAbort: false };
  }
  async isAvailable() {
    const node = spawnSync(process.execPath, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 5000 });
    const [major, minor] = String(node.stdout).trim().split('.').map(Number);
    if (node.status !== 0 || major < 22 || (major === 22 && minor < 19)) return false;
    if (!await super.isAvailable()) return false;
    return isSupportedPiVersion(await this.getVersion());
  }
  buildSessionArgs(options) {
    const args = ['--mode', 'json', '--no-approve'];
    if (options.model) args.push('--model', this.mapModel(options.model));
    if (options.thinking) args.push('--thinking', options.thinking);
    if (options.sessionId) args.push('--session', options.sessionId);
    if (options.tools?.length) args.push('--tools', options.tools.join(','));
    if (options.systemPrompt) args.push('--append-system-prompt', options.systemPrompt);
    if (options.budget) this.warnUnsupported('budgetControl', 'Budget control');
    if (options.maxTurns) this.warnUnsupported('maxTurns', 'Max turns');
    if (options.mcpConfig) this.warnUnsupported('mcpConfig', 'MCP configuration');
    args.push(options.prompt);
    return args;
  }
  buildAnalysisArgs(options) { return this.buildSessionArgs(options); }

  /**
   * Driver-owned argv after the binary for the version-bound direct-shell
   * profile. `--no-approve`, `--no-context-files`, `--no-extensions`,
   * `--no-skills` and `--no-mcp` are all fixed (never `--approve`, and
   * never omitted — `--no-approve` alone does not stop ancestor
   * AGENTS.md/CLAUDE.md loading); model and thinking level are always
   * explicit (never a CLI default or alias); the brief is validated here
   * but never placed in
   * argv — it travels on stdin (`stdin: 'brief-text'`). There is no
   * `-C/--cwd` flag to render: the launcher's own `cd` to the workspace is
   * the only binding.
   *
   * @param {{ selected?: { model?: unknown, effort?: { value?: unknown } }, cwd?: unknown, brief?: unknown }} invocation
   * @param {unknown} _profile
   * @param {unknown} _permissions
   * @returns {string[]}
   */
  buildWorkerArgs(invocation, _profile, _permissions) {
    const model = invocation?.selected?.model;
    if (typeof model !== 'string' || !model || model.includes('\0')) {
      throw new Error('Pi worker requires an explicit model');
    }
    const effort = invocation?.selected?.effort?.value ?? null;
    if (effort === null || !PI_DIRECT_EFFORT_VALUES.includes(effort)) {
      throw new Error('Pi worker requires an explicit qualified thinking level (never a CLI default)');
    }
    const cwd = invocation?.cwd;
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) {
      throw new Error('Pi worker requires an absolute workspace');
    }
    const brief = invocation?.brief;
    // Pi's own readPipedStdin() trims the stream; an all-whitespace brief
    // would resolve to no initial message at all, so it is refused here.
    if (typeof brief !== 'string' || !brief.trim() || brief.includes('\0')) {
      throw new Error('Pi worker requires a non-empty brief');
    }
    return ['--mode', 'json', '--no-approve', '--no-context-files', '--no-extensions', '--no-skills', '--no-mcp',
      '--model', model, '--thinking', effort];
  }

  mapModel(model) { return model; }
  getEnvOverrides() { return { CI: 'true', NO_COLOR: '1' }; }
  /** No stdin abort in `--mode json`; see getCapabilities() (#2550). */
  getAbortInput() { return null; }
  getTranscriptPath(sessionId) {
    if (!sessionId) return null;
    if (sessionId.endsWith('.jsonl') || sessionId.includes('/')) return sessionId;
    const root = process.env.PI_CODING_AGENT_SESSION_DIR;
    return root ? join(root, `${sessionId}.jsonl`) : join(homedir(), '.pi', 'agent', 'sessions', `${sessionId}.jsonl`);
  }
  /**
   * Legacy Ralph-loop contract (#2550), unchanged: parse `--mode json`
   * output into Pi's own JSONL events and report settlement only.
   * `settled` is an `agent_settled` event with no `agent_end` signalling
   * `willRetry: true`. This is the exact shape
   * `test/unit/ralph/pi-adapter.test.mjs` and the launcher depend on — it
   * does NOT extract or require a final answer; see `parseDirectFinal()`
   * for the strict direct-worker-profile contract that does.
   *
   * @param {string} stdout
   * @returns {{ events: object[], settled: boolean } | null}
   */
  parseOutput(stdout) {
    const events = [];
    for (const raw of stdout.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { return null; }
    }
    return events.length ? { events, settled: events.some(event => event.type === 'agent_settled')
      && !events.some(event => event.type === 'agent_end' && event.willRetry === true) } : null;
  }

  /**
   * Strict direct-worker-profile final: reuses `parseOutput()`'s event
   * parsing, then additionally requires a non-empty extracted assistant
   * answer and fails on any error signal (a standalone `error` event, an
   * `agent_end` with `willRetry: true`, or an `agent_end` assistant
   * message with `stopReason` `error`/`aborted`) even at exit zero. `text`
   * is the last assistant message's concatenated text content across all
   * `agent_end` events (a later `agent_end` can supersede an earlier one
   * before `agent_settled` arrives); `text` is non-null only when
   * `settled` is true. Used only by the direct worker profile
   * (roctinam/aiwg#2910) and the installed-module path — never the legacy
   * Ralph loop, which calls `parseOutput()` directly.
   *
   * @param {string} stdout
   * @returns {{ events: object[], settled: boolean, text: string|null } | null}
   */
  parseDirectFinal(stdout) {
    const events = [];
    for (const raw of stdout.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { return null; }
    }
    if (!events.length) return null;
    let failed = false;
    let settledEvent = false;
    let text = null;
    for (const event of events) {
      if (event.type === 'error') failed = true;
      if (event.type === 'agent_settled') settledEvent = true;
      if (event.type !== 'agent_end' || !Array.isArray(event.messages)) continue;
      if (event.willRetry === true || event.messages.some(message => message.stopReason === 'error' || message.stopReason === 'aborted')) {
        failed = true;
      }
      // Pi accumulates messages chronologically: the final answer is the LAST
      // assistant message of the LAST agent_end. An earlier non-empty message
      // must never stand in for an empty final one.
      const assistant = event.messages.filter(message => message.role === 'assistant').at(-1);
      if (!assistant) { text = null; continue; }
      const extracted = Array.isArray(assistant.content)
        ? assistant.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
        : (typeof assistant.text === 'string' ? assistant.text : null);
      text = extracted && extracted.trim() ? extracted : null;
    }
    const settled = settledEvent && !failed && Boolean(text);
    return { events, settled, text: settled ? text : null };
  }
}

// Self-register on import for the legacy Ralph loop only. The direct worker
// profile loads through the #2885 installed loader instead (see below).
registerProvider('pi', () => new PiAdapter());

/** Installed-module interface version (mirrors #2897 codex-adapter.mjs). */
export const interfaceVersion = 1;

/** Installed-module registration: exactly the one approved adapter ID. */
export function register(factory) {
  factory('pi', () => new PiAdapter());
}

export default PiAdapter;
