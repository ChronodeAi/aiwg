/** Pi Coding Agent adapter for headless External Ralph sessions. */
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { ProviderAdapter, registerProvider } from './provider-adapter.mjs';

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
    const node = spawnSync(process.execPath, ['-p', 'process.versions.node'], { encoding: 'utf8' });
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
  parseOutput(stdout) {
    const events = [];
    for (const raw of stdout.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { return null; }
    }
    return events.length ? { events, settled: events.some(event => event.type === 'agent_settled') } : null;
  }
}

registerProvider('pi', () => new PiAdapter());
export default PiAdapter;
