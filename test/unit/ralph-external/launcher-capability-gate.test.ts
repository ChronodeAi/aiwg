/**
 * Unit tests for ADR-001 launcher capability gating in SessionLauncher.
 *
 * Covers:
 *  - adapter-mandatory dispatch: launch without an adapter fails loud; the
 *    legacy inline buildArgs() path is unreachable when an adapter is set;
 *  - resume policy at the seam: sessionId + sessionResume:false → loud
 *    resume-refused event and a fresh session, no provider flag;
 *  - the structural capability gate: the launcher refuses to spawn when the
 *    adapter emits a flag its declared capabilities forbid;
 *  - per-adapter arg shape: claude/dsh/hermes buildSessionArgs() output
 *    contains no flags outside their declared capabilities.
 *
 * @source @tools/ralph-external/session-launcher.mjs
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

// @ts-ignore - ESM import
import { SessionLauncher } from '../../../tools/ralph-external/session-launcher.mjs';
// @ts-ignore - ESM import
import {
  ensureProvidersRegistered,
  createProvider,
  DispatchCapabilityError,
} from '../../../tools/ralph-external/lib/provider-adapter.mjs';

const CAPABILITY_FLAG_MAP: Record<string, string[]> = {
  sessionResume: ['--session-id', '--resume'],
  budgetControl: ['--max-budget-usd'],
  systemPrompt: ['--append-system-prompt'],
  streamJson: ['--output-format'],
  agentMode: ['--agent'],
  mcpConfig: ['--mcp-config'],
  maxTurns: ['--max-turns'],
};

const FULL_REQUEST = {
  prompt: 'Fix the bug',
  sessionId: 'test-session-123',
  model: 'sonnet',
  budget: 5.0,
  maxTurns: 10,
  verbose: true,
  systemPrompt: 'You are an expert developer',
  mcpConfig: { 'mcp-hound': { url: 'http://localhost:3000' } },
};

/**
 * Stub adapter whose binary is node itself, so spawns are real but inert.
 */
function makeStubAdapter(overrides: Record<string, any> = {}) {
  return {
    name: 'stub',
    binary: process.execPath,
    capabilities: {
      streamJson: false,
      sessionResume: false,
      budgetControl: false,
      systemPrompt: false,
      agentMode: false,
      mcpConfig: false,
      maxTurns: false,
    },
    args: ['-e', 'process.stdout.write("ok")'],
    getBinary() {
      return this.binary;
    },
    getName() {
      return this.name;
    },
    getCapabilities() {
      return { ...this.capabilities };
    },
    buildSessionArgs(_options: unknown) {
      return [...this.args];
    },
    buildAnalysisArgs(options: unknown) {
      return this.buildSessionArgs(options);
    },
    getEnvOverrides() {
      return {};
    },
    hasCapability(capability: string) {
      return !!this.capabilities[capability];
    },
    getTranscriptPath() {
      return null;
    },
    ...overrides,
  };
}

describe('SessionLauncher ADR-001 capability gating', () => {
  let launcher: any;
  let testDir: string;

  beforeEach(() => {
    launcher = new SessionLauncher();
    testDir = join('/tmp', `ralph-gate-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function launchOptions(overrides: Record<string, any> = {}) {
    return {
      prompt: 'Fix the bug',
      sessionId: 'test-session-123',
      workingDir: testDir,
      stdoutPath: join(testDir, 'stdout.log'),
      stderrPath: join(testDir, 'stderr.log'),
      outputDir: join(testDir, 'output'),
      ...overrides,
    };
  }

  describe('adapter-mandatory dispatch', () => {
    it('fails loud when no adapter is set (no claude fallback)', async () => {
      await expect(launcher.launch(launchOptions())).rejects.toThrow(
        /No provider adapter configured/
      );
    });

    it('dispatches only through the adapter; legacy buildArgs is unreachable', async () => {
      const adapter = makeStubAdapter();
      launcher.setProviderAdapter(adapter);
      const buildArgsSpy = vi.spyOn(launcher, 'buildArgs');

      let startedArgs: any = null;
      launcher.on('started', (evt: any) => {
        startedArgs = evt.args;
      });

      const result = await launcher.launch(launchOptions());

      expect(result.exitCode).toBe(0);
      // Spawned args are exactly the adapter's buildSessionArgs output.
      expect(startedArgs).toEqual(adapter.args);
      // The legacy claude-style inline path was never consulted.
      expect(buildArgsSpy).not.toHaveBeenCalled();
    });
  });

  describe('resume policy at the seam (ADR-001 §4)', () => {
    it('refuses resume loudly and starts fresh when sessionResume is false', async () => {
      const adapter = makeStubAdapter(); // sessionResume: false
      launcher.setProviderAdapter(adapter);

      const refused: any[] = [];
      launcher.on('resume-refused', (evt: any) => refused.push(evt));

      let startedArgs: any = null;
      launcher.on('started', (evt: any) => {
        startedArgs = evt.args;
      });

      await launcher.launch(launchOptions()); // carries sessionId

      expect(refused).toHaveLength(1);
      expect(refused[0].provider).toBe('stub');
      expect(refused[0].sessionId).toBe('test-session-123');
      expect(refused[0].action).toBe('fresh-session');
      // Fresh session: no provider flag carries the session identity.
      expect(startedArgs).not.toContain('--session-id');
      expect(startedArgs).not.toContain('--resume');
    });

    it('does not emit resume-refused when the adapter supports resume', async () => {
      const adapter = makeStubAdapter({
        capabilities: { streamJson: false, sessionResume: true, budgetControl: false, systemPrompt: false, agentMode: false, mcpConfig: false, maxTurns: false },
      });
      launcher.setProviderAdapter(adapter);

      const refused: any[] = [];
      launcher.on('resume-refused', (evt: any) => refused.push(evt));

      await launcher.launch(launchOptions());

      expect(refused).toHaveLength(0);
    });
  });

  describe('structural capability gate', () => {
    it('refuses to spawn when the adapter emits an undeclared flag', async () => {
      const adapter = makeStubAdapter({
        args: ['--output-format', 'stream-json', 'Fix the bug'],
      }); // streamJson: false, but emits --output-format
      launcher.setProviderAdapter(adapter);

      let started = false;
      launcher.on('started', () => {
        started = true;
      });

      await expect(launcher.launch(launchOptions())).rejects.toThrow(DispatchCapabilityError);
      expect(started).toBe(false);
    });

    it('permits flags the adapter does declare', async () => {
      const adapter = makeStubAdapter({
        capabilities: { streamJson: true, sessionResume: false, budgetControl: false, systemPrompt: false, agentMode: false, mcpConfig: false, maxTurns: false },
        args: ['--output-format', 'stream-json', 'Fix the bug'],
      });
      launcher.setProviderAdapter(adapter);

      let started = false;
      launcher.on('started', () => {
        started = true;
      });

      // The declared flag passes the gate and dispatch reaches spawn. The
      // stub binary (node) itself rejects the foreign flag with exit code 9 —
      // which proves the launcher forwarded it rather than the gate blocking it.
      await expect(launcher.launch(launchOptions())).resolves.toBeDefined();
      expect(started).toBe(true);
    });
  });

  describe('per-adapter arg shape (declared capabilities vs emitted flags)', () => {
    let adapters: Record<string, any> = {};

    beforeAll(async () => {
      await ensureProvidersRegistered();
      adapters = {
        claude: createProvider('claude'),
        dsh: createProvider('dsh'),
        hermes: createProvider('hermes'),
      };
    });

    it('no adapter emits a flag its capabilities do not declare', () => {
      for (const [name, adapter] of Object.entries(adapters)) {
        const caps = adapter.getCapabilities();
        const args = adapter.buildSessionArgs(FULL_REQUEST);
        for (const [capability, flags] of Object.entries(CAPABILITY_FLAG_MAP)) {
          if (caps[capability]) continue;
          for (const flag of flags) {
            expect(args, `${name} emitted ${flag} with ${capability}=false`).not.toContain(flag);
          }
        }
      }
    });

    it('dsh golden: profile + prompt only, prompt last', () => {
      const args = adapters.dsh.buildSessionArgs(FULL_REQUEST);
      for (const flag of [
        '--resume',
        '--session-id',
        '--model',
        '--output-format',
        '--max-budget-usd',
        '--append-system-prompt',
        '--mcp-config',
        '--max-turns',
        '--agent',
      ]) {
        expect(args).not.toContain(flag);
      }
      expect(args[0]).toBe('--profile');
      expect(args[args.length - 1]).toBe('Fix the bug');
    });

    it('claude golden: sessionId maps to --session-id, prompt last', () => {
      const args = adapters.claude.buildSessionArgs(FULL_REQUEST);
      const sessionIndex = args.indexOf('--session-id');
      expect(sessionIndex).toBeGreaterThan(-1);
      expect(args[sessionIndex + 1]).toBe('test-session-123');
      expect(args[args.length - 1]).toBe('Fix the bug');
    });

    it('hermes golden: prompt rides as -z value, nothing positional (H-1 observed)', () => {
      const args = adapters.hermes.buildSessionArgs(FULL_REQUEST);
      expect(args).toEqual(['-z', 'Fix the bug']);
    });
  });
});
