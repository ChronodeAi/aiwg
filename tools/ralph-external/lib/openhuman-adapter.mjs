/**
 * OpenHuman direct-worker driver (B-OG-47, roctinam/aiwg#2911).
 *
 * Version-bound to the source-evidenced `openhuman-core` 0.64.14 one-shot RPC
 * call (tinyhumansai/openhuman@216ea322a3c1269dada70751ac5c08eac7dc7596):
 *
 *   openhuman-core --model M call --method openhuman.agent_chat --params-stdin
 *
 * `--params-stdin` reads stdin to EOF and is mutually exclusive with
 * `--params` (crates/openhuman-core/src/core/cli.rs:445-468); the result is
 * pretty-printed JSON on stdout (cli.rs:486). The params document
 * (`message`, `model_override`, `cwd`; agent/schemas.rs:97-105) is framed by
 * the conductor from the brief (`stdin: 'brief-json'`,
 * src/serve/worker-stdin-frame.mjs), so prompt text never enters argv.
 *
 * Installed-module shape: self-contained, with static `interfaceVersion` and
 * `register` exports, so the #2885 loader can approve it by digest under
 * `installed:openhuman`. It is not a Ralph loop provider (no session,
 * resume, abort or effort surface is evidenced). Documentation/source
 * evidence and synthetic fixtures never qualify it: the bundled profile stays
 * unqualified until an authorized live run.
 */

export const interfaceVersion = 1;

export const OPENHUMAN_SUPPORTED_VERSIONS = Object.freeze(['0.64.14']);
export const OPENHUMAN_SOURCE_REVISION = '216ea322a3c1269dada70751ac5c08eac7dc7596';
export const OPENHUMAN_CHAT_METHOD = 'openhuman.agent_chat';

export class OpenHumanAdapter {
  getBinary() { return 'openhuman-core'; }
  getName() { return 'openhuman'; }
  getCapabilities() {
    return { streamJson: false, sessionResume: false, budgetControl: false, systemPrompt: false,
      agentMode: false, mcpConfig: false, maxTurns: false, rpcAbort: false };
  }
  buildSessionArgs() {
    throw new Error('OpenHuman has no qualified Ralph loop session; use the direct worker profile');
  }
  buildAnalysisArgs() { return this.buildSessionArgs(); }

  /** Driver-owned argv after the binary: no brief text, no permission flags
   * (no per-call sandbox/approval control is evidenced; the qualified external
   * boundary owns them) and never a guessed effort. */
  buildWorkerArgs(invocation, _profile, _permissions) {
    const effort = invocation?.selected?.effort?.value ?? null;
    if (effort !== null) throw new Error('OpenHuman has no evidenced effort control');
    const model = invocation?.selected?.model;
    if (typeof model !== 'string' || !model || model.includes('\0')) throw new Error('OpenHuman worker requires an explicit model');
    const cwd = invocation?.cwd;
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) throw new Error('OpenHuman worker requires an absolute workspace');
    return ['--model', model, 'call', '--method', OPENHUMAN_CHAT_METHOD, '--params-stdin'];
  }

  /** Final-only output: no stream grammar is evidenced, so no event is invented. */
  observeHealthEvent() { return null; }

  /** Strict single JSON object; truncated or non-object output is not a final. */
  parseOutput(stdout) {
    if (typeof stdout !== 'string' || !stdout.trim()) return null;
    try {
      const value = JSON.parse(stdout);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch { return null; }
  }

  getAbortInput() { return null; }
}

/** Installed-module registration: exactly the one approved adapter ID. */
export function register(factory) {
  factory('openhuman', () => new OpenHumanAdapter());
}

export default OpenHumanAdapter;
