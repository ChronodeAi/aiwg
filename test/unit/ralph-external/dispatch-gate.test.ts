/**
 * Unit tests for the ADR-002 deliverable write-path gate in SessionLauncher.
 *
 * Covers (ADR-002 §Verification):
 *  - "target outside sandbox root refuses launch": dispatch with a deliverable
 *    path outside the effective sandbox root → launch() rejects with
 *    DeliverableUnwritableError naming BOTH the target and the sandbox root,
 *    and no spawn occurs (no allocation at all);
 *  - unwritable target inside the root → refused before spawn;
 *  - projectRoot containment invariant (sandboxRoot ⊇ projectRoot);
 *  - sandbox-root resolution: adapter-declared getSandboxRoot() wins; absence
 *    defaults the root to workingDir (documented migration default);
 *  - writable target inside the root → dispatch completes.
 *
 * @source @tools/ralph-external/session-launcher.mjs
 * @decision @.aiwg/architecture/ADR-002-deliverable-write-path-fail-loud.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join, resolve as resolvePath } from 'path';

// @ts-ignore - ESM import
import {
  SessionLauncher,
  DeliverableUnwritableError,
  assertDeliverableWritable,
} from '../../../tools/ralph-external/session-launcher.mjs';

/**
 * Stub adapter whose binary is node itself, so spawns are real but inert.
 * Mirrors the launcher-capability-gate.test.ts stub (ADR-001).
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

describe('SessionLauncher ADR-002 deliverable write-path gate', () => {
  let launcher: any;
  let testDir: string;

  beforeEach(() => {
    launcher = new SessionLauncher();
    testDir = join('/tmp', `ralph-gate-adr002-${Date.now()}`);
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

  async function captureRejection(promise: Promise<any>): Promise<any> {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    return null;
  }

  describe('target outside sandbox root refuses launch (fail loud, no spawn)', () => {
    it('rejects with DeliverableUnwritableError naming BOTH target and sandbox root', async () => {
      const adapter = makeStubAdapter({
        getSandboxRoot: () => testDir, // adapter-declared root (ADR-002 §3)
      });
      launcher.setProviderAdapter(adapter);

      const target = join(testDir, '..', `outside-${Date.now()}`, 'deliverable.md');
      let started = false;
      launcher.on('started', () => {
        started = true;
      });

      const err = await captureRejection(
        launcher.launch(launchOptions({ deliverablePath: target }))
      );

      expect(err).toBeInstanceOf(DeliverableUnwritableError);
      expect(err.message).toContain(resolvePath(target)); // the unwritable target
      expect(err.message).toContain(resolvePath(testDir)); // the effective sandbox root
      expect(err.message).toMatch(/unwritable under provider sandbox root/);
      expect(err.message).toContain('(provider: stub)');
      expect(err.target).toBe(resolvePath(target));
      expect(err.sandboxRoot).toBe(resolvePath(testDir));
      expect(started).toBe(false);
    });

    it('allocates nothing on refusal: output dirs are not created', async () => {
      const adapter = makeStubAdapter({ getSandboxRoot: () => testDir });
      launcher.setProviderAdapter(adapter);

      const outputDir = join(testDir, 'output');
      const target = join(testDir, '..', `outside-${Date.now()}`, 'deliverable.md');

      await captureRejection(launcher.launch(launchOptions({ deliverablePath: target })));

      // mkdirSync of output dirs runs only after the gate — a refused
      // dispatch allocates nothing (ADR-002 §1).
      expect(existsSync(outputDir)).toBe(false);
      expect(existsSync(join(testDir, 'stdout.log'))).toBe(false);
    });
  });

  describe('unwritable target inside the root refuses launch', () => {
    it('refuses before spawn when a path component blocks the deliverable tree', async () => {
      const adapter = makeStubAdapter({ getSandboxRoot: () => testDir });
      launcher.setProviderAdapter(adapter);

      // A regular file where a directory is required: the sentinel probe at
      // the dir-of-file fails with ENOTDIR — a portable unwritable-tree case.
      writeFileSync(join(testDir, 'blocker'), 'not a directory');
      const target = join(testDir, 'blocker', 'deliverable.md');

      let started = false;
      launcher.on('started', () => {
        started = true;
      });

      const err = await captureRejection(
        launcher.launch(launchOptions({ deliverablePath: target }))
      );

      expect(err).toBeInstanceOf(DeliverableUnwritableError);
      expect(err.message).toContain(resolvePath(target));
      expect(started).toBe(false);
    });
  });

  describe('projectRoot containment invariant (sandboxRoot ⊇ projectRoot)', () => {
    it('rejects a projectRoot outside the declared sandbox root before spawn', async () => {
      const sandboxRoot = join(testDir, 'sandbox');
      const adapter = makeStubAdapter({ getSandboxRoot: () => sandboxRoot });
      launcher.setProviderAdapter(adapter);

      let started = false;
      launcher.on('started', () => {
        started = true;
      });

      const err = await captureRejection(
        launcher.launch(
          launchOptions({
            projectRoot: testDir, // parent of the declared root → outside
            deliverablePath: join(testDir, 'deliverable.md'),
          })
        )
      );

      expect(err).toBeInstanceOf(DeliverableUnwritableError);
      expect(err.message).toContain('projectRoot lies outside the sandbox root');
      expect(started).toBe(false);
    });

    it('probes projectRoot writability before spawn', async () => {
      const adapter = makeStubAdapter({ getSandboxRoot: () => testDir });
      launcher.setProviderAdapter(adapter);

      writeFileSync(join(testDir, 'blocker'), 'not a directory');
      let started = false;
      launcher.on('started', () => {
        started = true;
      });

      const err = await captureRejection(
        launcher.launch(launchOptions({ projectRoot: join(testDir, 'blocker') }))
      );

      expect(err).toBeInstanceOf(DeliverableUnwritableError);
      expect(started).toBe(false);
    });
  });

  describe('sandbox-root resolution', () => {
    it('defaults the root to workingDir when the adapter does not declare getSandboxRoot', async () => {
      const adapter = makeStubAdapter(); // no getSandboxRoot
      launcher.setProviderAdapter(adapter);

      let started = false;
      launcher.on('started', () => {
        started = true;
      });

      const err = await captureRejection(
        launcher.launch(
          launchOptions({
            deliverablePath: join(testDir, '..', `outside-${Date.now()}`, 'deliverable.md'),
          })
        )
      );

      expect(err).toBeInstanceOf(DeliverableUnwritableError);
      expect(err.sandboxRoot).toBe(resolvePath(testDir));
      expect(started).toBe(false);
    });

    it('honors the adapter-declared root over workingDir', async () => {
      // The deliverable lives OUTSIDE workingDir but INSIDE the
      // adapter-declared root → the dispatch proceeds: the adapter owns
      // sandbox topology (ADR-002 §3).
      const sandboxRoot = join(testDir, 'declared-root');
      mkdirSync(sandboxRoot, { recursive: true });
      const adapter = makeStubAdapter({ getSandboxRoot: () => sandboxRoot });
      launcher.setProviderAdapter(adapter);

      let started = false;
      launcher.on('started', () => {
        started = true;
      });

      await launcher.launch(
        launchOptions({ deliverablePath: join(sandboxRoot, 'deep', 'deliverable.md') })
      );

      expect(started).toBe(true);
    });
  });

  describe('writable target inside the root completes', () => {
    it('launches and completes when the deliverable tree is writable', async () => {
      const adapter = makeStubAdapter({ getSandboxRoot: () => testDir });
      launcher.setProviderAdapter(adapter);

      let started = false;
      launcher.on('started', () => {
        started = true;
      });

      const result = await launcher.launch(
        launchOptions({ deliverablePath: join(testDir, 'out', 'deliverable.md') }) // tree not pre-existing
      );

      expect(started).toBe(true);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('assertDeliverableWritable (direct)', () => {
    it('returns true for a writable target under the root', () => {
      expect(
        assertDeliverableWritable({
          targetPath: join(testDir, 'fresh', 'deliverable.md'),
          sandboxRoot: testDir,
          provider: 'stub',
        })
      ).toBe(true);
    });

    it('throws the typed error with both paths for a target outside the root', () => {
      const target = join(testDir, '..', `sneaky-${Date.now()}`, 'd.md');
      let caught: any = null;
      try {
        assertDeliverableWritable({ targetPath: target, sandboxRoot: testDir, provider: 'stub' });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DeliverableUnwritableError);
      expect(caught.message).toContain(resolvePath(target));
      expect(caught.message).toContain(resolvePath(testDir));
    });
  });
});
