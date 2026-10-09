import { spawnSync } from 'node:child_process';
import { ProviderAdapter, registerProvider } from './provider-adapter.mjs';
import { OmpFrameDecoder, summarizeOmpEvents, OmpRpcClient, MAX_FRAME, MAX_MESSAGE } from '../../providers/omp-transport.mjs';
import { createWorkerHealthObserver, healthEventMatchesBinding } from './worker-health.mjs';

/** Oh My Pi's native flags/events intentionally differ from Pi. */
export class OmpAdapter extends ProviderAdapter {
  createHealthObserver(options = {}) {
    // Reuse OMP's owned v2 chunk grammar. Neither another CLI's framing nor
    // the strict worker-final parser is a substitute for native reassembly.
    const messageLimit = Math.min(options.maxMessageBytes ?? 4 * MAX_FRAME, MAX_MESSAGE);
    let decoder = new OmpFrameDecoder({ messageLimit });
    let lastSource = null;
    const observer = createWorkerHealthObserver({ ...options, provider: this.getName(),
      maxFrameBytes: options.maxFrameBytes ?? MAX_FRAME,
      normalizeEvent: (frame, source, binding) => {
        if (source.kind !== 'stdout') return null;
        const identity = `${source.id}:${source.generation}`;
        if (lastSource !== null && lastSource !== identity) decoder = new OmpFrameDecoder({ messageLimit });
        lastSource = identity;
        try {
          const event = decoder.decode(frame);
          return event ? this.observeHealthEvent(event, source, binding) : null;
        } catch (error) {
          decoder = new OmpFrameDecoder({ messageLimit });
          throw error;
        }
      },
    });
    const finish = observer.finish;
    observer.finish = observation => {
      try { decoder.end(); } catch { observer.gap('MALFORMED_FRAME'); }
      return finish(observation);
    };
    return observer;
  }
  observeHealthEvent(event, source, binding) {
    if (source.kind !== 'stdout' || !event || typeof event !== 'object') return null;
    if (!healthEventMatchesBinding({ sessionId: event.sessionId }, binding)) return null;
    if (event.type === 'agent_start') return { kind: 'accepted' };
    if (event.type === 'tool_execution_end') {
      if (event.isError === true) return { kind: 'error', reasonCode: 'tool-failed' };
      if (typeof event.toolCallId === 'string') return { kind: 'progress', key: event.toolCallId };
      return { kind: 'activity' };
    }
    if (event.type === 'agent_end') {
      if (Array.isArray(event.messages) && event.messages.some(message => message.stopReason === 'error' || message.stopReason === 'aborted')) return { kind: 'error', reasonCode: 'provider-failed' };
      return event.willContinue === true ? { kind: 'activity' } : { kind: 'terminal', success: true, key: 'agent_end' };
    }
    if (event.type === 'rpc_frame_error' || event.type === 'error') return { kind: 'error', reasonCode: 'provider-failed' };
    return null;
  }
  async getVersion() { const result = spawnSync(this.getBinary(), ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 }); return result.status === 0 ? result.stdout.trim() : null; }
  async isAvailable() { return Boolean(await this.getVersion()); }
  getName() { return 'omp'; }
  getBinary() { return process.env.AIWG_OMP_BIN || 'omp'; }
  getCapabilities() { return { streamJson: true, sessionResume: true, budgetControl: false, systemPrompt: true, agentMode: false, mcpConfig: false, maxTurns: false, rpcAbort: true }; }
  buildSessionArgs(options) {
    const args = ['--mode', 'json'];
    if (options.profile) args.push('--profile', options.profile);
    for (const config of options.config ?? []) args.push('--config', config);
    if (options.model) args.push('--model', this.mapModel(options.model));
    if (options.thinking) args.push('--thinking', options.thinking);
    if (options.sessionId) args.push('--session', options.sessionId);
    if (options.sessionDir) args.push('--session-dir', options.sessionDir);
    if (options.noSession) args.push('--no-session');
    if (options.noExtensions) args.push('--no-extensions');
    if (options.tools) { if (options.tools.length) args.push('--tools', options.tools.join(',')); else args.push('--no-tools'); }
    if (options.systemPrompt) args.push('--append-system-prompt', options.systemPrompt);
    for (const [option, capability] of [['budget', 'budgetControl'], ['maxTurns', 'maxTurns'], ['mcpConfig', 'mcpConfig']]) if (options[option]) this.warnUnsupported(capability, option);
    args.push('--', options.prompt);
    return args;
  }
  buildAnalysisArgs(options) { return this.buildSessionArgs(options); }
  mapModel(model) { return model; }
  getEnvOverrides() { return { CI: 'true', NO_COLOR: '1' }; }
  // JSON print mode has no stdin abort protocol; runner terminates its process.
  getAbortInput() { return null; }
  createRpcClient(options = {}) { return new OmpRpcClient({ binary: this.getBinary(), ...options }); }
  getTranscriptPath(sessionId) { return sessionId?.endsWith('.jsonl') ? sessionId : null; }
  parseOutput(stdout, options = {}) {
    if (Buffer.byteLength(stdout) > MAX_MESSAGE) return null;
    try { const decoder = new OmpFrameDecoder({ frameLimit: MAX_MESSAGE }); const events = decoder.push(Buffer.from(stdout)); decoder.end(); return events.length ? summarizeOmpEvents(events, options) : null; } catch { return null; }
  }
}
registerProvider('omp', () => new OmpAdapter());
export default OmpAdapter;
