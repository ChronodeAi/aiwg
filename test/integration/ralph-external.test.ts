/**
 * Integration tests for External Ralph Loop
 *
 * Tests the full orchestration flow with mocked Claude sessions.
 *
 * @source @tools/ralph-external/orchestrator.mjs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Import modules under test
// @ts-ignore - ESM import
import { Orchestrator } from '../../tools/ralph-external/orchestrator.mjs';

describe('External Ralph Loop Integration', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `ralph-external-integration-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  describe('execute', () => {
    it('should complete successfully on first iteration when task succeeds', { timeout: 10000 }, async () => {
      const orchestrator = new Orchestrator(testDir);

      // Mock session launcher
      vi.spyOn(orchestrator.sessionLauncher, 'launch').mockResolvedValue({
        exitCode: 0,
        killed: false,
        pid: 12345,
      });

      // Mock output analyzer - immediate success
      vi.spyOn(orchestrator.outputAnalyzer, 'analyze').mockResolvedValue({
        completed: true,
        success: true,
        failureClass: null,
        completionPercentage: 100,
        shouldContinue: false,
        learnings: 'Task completed successfully',
        artifactsModified: ['src/feature.ts'],
        blockers: [],
        nextApproach: '',
      });

      vi.spyOn(orchestrator.stateManager, 'setCurrentPid').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await orchestrator.execute({
        objective: 'Create a test file',
        completionCriteria: 'Test file exists',
        maxIterations: 5,
        enablePIDControl: false,
        enableOverseer: false,
        enableSemanticMemory: false,
        crossTask: false,
        enableAnalytics: false,
        enableBestOutput: false,
        enableEarlyStopping: false,
        enableClaudeIntelligence: false,
        enableSnapshots: false,
        enableCheckpoints: false,
      });

      expect(result.success).toBe(true);
      expect(result.reason).toBe('Task completed successfully');
      expect(result.iterations).toBe(1);
      expect(result.loopId).toBeDefined();

      // Check state was saved
      const finalState = orchestrator.stateManager.load();
      expect(finalState?.status).toBe('completed');
    });

    it('should iterate multiple times when task is incomplete', { timeout: 10000 }, async () => {
      const orchestrator = new Orchestrator(testDir);
      let callCount = 0;

      vi.spyOn(orchestrator.sessionLauncher, 'launch').mockResolvedValue({
        exitCode: 0,
        killed: false,
        pid: 12345,
      });

      // Incomplete first 2 times, complete on 3rd
      vi.spyOn(orchestrator.outputAnalyzer, 'analyze').mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          return {
            completed: false,
            success: null,
            failureClass: null,
            completionPercentage: callCount * 30,
            shouldContinue: true,
            learnings: `Progress in iteration ${callCount}`,
            artifactsModified: [`file${callCount}.ts`],
            blockers: [],
            nextApproach: 'Continue implementation',
          };
        }
        return {
          completed: true,
          success: true,
          failureClass: null,
          completionPercentage: 100,
          shouldContinue: false,
          learnings: 'All done',
          artifactsModified: ['final.ts'],
          blockers: [],
          nextApproach: '',
        };
      });

      vi.spyOn(orchestrator.stateManager, 'setCurrentPid').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await orchestrator.execute({
        objective: 'Complex task',
        completionCriteria: 'All tests pass',
        maxIterations: 5,
        enablePIDControl: false,
        enableOverseer: false,
        enableSemanticMemory: false,
        crossTask: false,
        enableAnalytics: false,
        enableBestOutput: false,
        enableEarlyStopping: false,
        enableClaudeIntelligence: false,
        enableSnapshots: false,
        enableCheckpoints: false,
      });

      expect(result.success).toBe(true);
      expect(result.iterations).toBe(3);

      // Check accumulated state
      const finalState = orchestrator.stateManager.load();
      expect(finalState?.iterations).toHaveLength(3);
      expect(finalState?.filesModified).toContain('file1.ts');
      expect(finalState?.filesModified).toContain('file2.ts');
      expect(finalState?.filesModified).toContain('final.ts');
    });

    it('promotes learnings from a verified completion and ends after that iteration', { timeout: 10000 }, async () => {
      const orchestrator = new Orchestrator(testDir);

      const launch = vi.spyOn(orchestrator.sessionLauncher, 'launch').mockResolvedValue({
        exitCode: 0,
        killed: false,
        pid: 12345,
      });

      vi.spyOn(orchestrator.outputAnalyzer, 'analyze').mockResolvedValue({
        completed: true,
        success: true,
        failureClass: null,
        completionPercentage: 100,
        shouldContinue: false,
        progressMade: true,
        learnings: 'Implemented the change step by step',
        artifactsModified: ['src/feature.ts'],
        blockers: [],
        nextApproach: '',
      });

      vi.spyOn(orchestrator.stateManager, 'setCurrentPid').mockImplementation(() => {});
      const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await orchestrator.execute({
        objective: 'Implement the feature',
        completionCriteria: 'Feature tests pass',
        maxIterations: 3,
        enablePIDControl: false,
        enableOverseer: false,
        enableSemanticMemory: true,
        crossTask: false,
        enableAnalytics: false,
        enableBestOutput: false,
        enableEarlyStopping: false,
        enableClaudeIntelligence: false,
        enableSnapshots: false,
        enableCheckpoints: false,
      });

      expect(errors).not.toHaveBeenCalled();
      expect(launch).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.iterations).toBe(1);
      expect(logs).toHaveBeenCalledWith(expect.stringMatching(/Learnings: extracted=\d+, validated=\d+, rejected=\d+, promoted=\d+, skipped=\d+/));

      const finalState = orchestrator.stateManager.load();
      expect(finalState?.status).toBe('completed');
      expect(finalState?.iterations.map((iteration: { status: string }) => iteration.status)).toEqual(['completed']);
    });

    it('runs the PID controller from iteration 2 and records its advisory decision', { timeout: 10000 }, async () => {
      const orchestrator = new Orchestrator(testDir);
      let callCount = 0;

      vi.spyOn(orchestrator.sessionLauncher, 'launch').mockResolvedValue({
        exitCode: 0,
        killed: false,
        pid: 12345,
      });

      // Incomplete twice, complete on the third iteration.
      vi.spyOn(orchestrator.outputAnalyzer, 'analyze').mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          return {
            completed: false,
            success: null,
            failureClass: null,
            completionPercentage: callCount * 30,
            shouldContinue: true,
            learnings: `Progress in iteration ${callCount}`,
            artifactsModified: [],
            blockers: [],
            nextApproach: 'Continue implementation',
          };
        }
        return {
          completed: true,
          success: true,
          failureClass: null,
          completionPercentage: 100,
          shouldContinue: false,
          learnings: 'All done',
          artifactsModified: [],
          blockers: [],
          nextApproach: '',
        };
      });

      vi.spyOn(orchestrator.stateManager, 'setCurrentPid').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await orchestrator.execute({
        objective: 'PID-controlled task',
        completionCriteria: 'All tests pass',
        maxIterations: 5,
        enablePIDControl: true,
        enableOverseer: false,
        enableSemanticMemory: false,
        crossTask: false,
        enableAnalytics: false,
        enableBestOutput: false,
        enableEarlyStopping: false,
        enableClaudeIntelligence: false,
        enableSnapshots: false,
        enableCheckpoints: false,
      });

      expect(errors).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.iterations).toBe(3);

      const finalState = orchestrator.stateManager.load();
      expect(finalState?.iterations.map((iteration: { status: string }) => iteration.status))
        .toEqual(['incomplete', 'incomplete', 'completed']);
      // No previous iteration to judge before the first session.
      expect(finalState?.iterations[0].controlSignals).toBeNull();
      for (const iteration of finalState!.iterations.slice(1)) {
        expect(['continue', 'adjust', 'pause', 'abort']).toContain(iteration.controlSignals.action);
      }
    });

    it('should stop when max iterations reached', { timeout: 10000 }, async () => {
      const orchestrator = new Orchestrator(testDir);

      vi.spyOn(orchestrator.sessionLauncher, 'launch').mockResolvedValue({
        exitCode: 0,
        killed: false,
        pid: 12345,
      });

      // Always incomplete
      vi.spyOn(orchestrator.outputAnalyzer, 'analyze').mockResolvedValue({
        completed: false,
        success: null,
        failureClass: null,
        completionPercentage: 50,
        shouldContinue: true,
        learnings: 'Making progress',
        artifactsModified: [],
        blockers: [],
        nextApproach: 'Keep trying',
      });

      vi.spyOn(orchestrator.stateManager, 'setCurrentPid').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await orchestrator.execute({
        objective: 'Impossible task',
        completionCriteria: 'Never achievable',
        maxIterations: 3,
        enablePIDControl: false,
        enableOverseer: false,
        enableSemanticMemory: false,
        crossTask: false,
        enableAnalytics: false,
        enableBestOutput: false,
        enableEarlyStopping: false,
        enableClaudeIntelligence: false,
        enableSnapshots: false,
        enableCheckpoints: false,
      });

      expect(result.success).toBe(false);
      expect(result.reason).toBe('Maximum iterations reached');
      expect(result.iterations).toBe(3);

      const finalState = orchestrator.stateManager.load();
      expect(finalState?.status).toBe('limit_reached');
    });

    it('records a session stopped by the per-iteration cap and still enforces cumulative ceilings', { timeout: 10000 }, async () => {
      const orchestrator = new Orchestrator(testDir);

      // A provider without native budget control, stopped live at its
      // per-iteration budget (SessionLauncher result shape).
      const launch = vi.spyOn(orchestrator.sessionLauncher, 'launch').mockResolvedValue({
        exitCode: 1,
        timedOut: false,
        budgetExceeded: true,
        toolCallCount: 3,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costUsd: 2.5,
        tokenUsageObserved: true,
        costObserved: true,
      });

      vi.spyOn(orchestrator.outputAnalyzer, 'analyze').mockResolvedValue({
        completed: false,
        success: null,
        failureClass: null,
        completionPercentage: 50,
        shouldContinue: true,
        learnings: 'Stopped at the session cap',
        artifactsModified: [],
        blockers: [],
        nextApproach: 'Continue',
      });

      vi.spyOn(orchestrator.stateManager, 'setCurrentPid').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await orchestrator.execute({
        objective: 'Capped task',
        completionCriteria: 'Never achievable',
        maxIterations: 10,
        budgetPerIteration: 2.5,
        budgetLimits: { spend_usd: 4 },
        enablePIDControl: false,
        enableOverseer: false,
        enableSemanticMemory: false,
        crossTask: false,
        enableAnalytics: true,
        enableBestOutput: false,
        enableEarlyStopping: false,
        enableClaudeIntelligence: false,
        enableSnapshots: false,
        enableCheckpoints: false,
      });

      expect(launch).toHaveBeenCalledWith(expect.objectContaining({ budget: 2.5 }));
      // $2.50 per capped session: the cumulative $4 ceiling stops the loop
      // after the second session.
      expect(result.success).toBe(false);
      expect(result.reason).toBe('Budget exhausted: spend_exhausted');
      expect(result.iterations).toBe(2);

      const finalState = orchestrator.stateManager.load();
      expect(finalState?.status).toBe('budget_exhausted');
      expect(finalState?.iterations.map((iteration: { budgetExceeded?: boolean }) => iteration.budgetExceeded)).toEqual([true, true]);
      expect(orchestrator.iterationAnalytics.iterations.map((record: { session_budget_exceeded?: boolean }) => record.session_budget_exceeded)).toEqual([true, true]);
    });

    it('should stop when shouldContinue is false', { timeout: 10000 }, async () => {
      const orchestrator = new Orchestrator(testDir);

      vi.spyOn(orchestrator.sessionLauncher, 'launch').mockResolvedValue({
        exitCode: 1,
        killed: false,
        pid: 12345,
      });

      // Can't continue due to blocker
      vi.spyOn(orchestrator.outputAnalyzer, 'analyze').mockResolvedValue({
        completed: false,
        success: null,
        failureClass: 'budget_exceeded',
        completionPercentage: 40,
        shouldContinue: false,
        learnings: 'Budget exceeded',
        artifactsModified: [],
        blockers: ['Out of budget'],
        nextApproach: '',
      });

      vi.spyOn(orchestrator.stateManager, 'setCurrentPid').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await orchestrator.execute({
        objective: 'Task that exceeds budget',
        completionCriteria: 'Complete',
        maxIterations: 10,
        enablePIDControl: false,
        enableOverseer: false,
        enableSemanticMemory: false,
        crossTask: false,
        enableAnalytics: false,
        enableBestOutput: false,
        enableEarlyStopping: false,
        enableClaudeIntelligence: false,
        enableSnapshots: false,
        enableCheckpoints: false,
      });

      expect(result.success).toBe(false);
      expect(result.reason).toBe('budget_exceeded');
      expect(result.iterations).toBe(1);

      const finalState = orchestrator.stateManager.load();
      expect(finalState?.status).toBe('failed');
    });

    it('should handle session errors and continue', { timeout: 10000 }, async () => {
      const orchestrator = new Orchestrator(testDir);
      let callCount = 0;

      // Error on first call, succeed on second
      vi.spyOn(orchestrator.sessionLauncher, 'launch').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Session crashed');
        }
        return { exitCode: 0, killed: false, pid: 12345 };
      });

      vi.spyOn(orchestrator.outputAnalyzer, 'analyze').mockResolvedValue({
        completed: true,
        success: true,
        failureClass: null,
        completionPercentage: 100,
        shouldContinue: false,
        learnings: 'Recovered',
        artifactsModified: [],
        blockers: [],
        nextApproach: '',
      });

      vi.spyOn(orchestrator.stateManager, 'setCurrentPid').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await orchestrator.execute({
        objective: 'Task with recovery',
        completionCriteria: 'Complete',
        maxIterations: 5,
        enablePIDControl: false,
        enableOverseer: false,
        enableSemanticMemory: false,
        crossTask: false,
        enableAnalytics: false,
        enableBestOutput: false,
        enableEarlyStopping: false,
        enableClaudeIntelligence: false,
        enableSnapshots: false,
        enableCheckpoints: false,
      });

      expect(result.success).toBe(true);
      expect(result.iterations).toBe(2);

      const finalState = orchestrator.stateManager.load();
      expect(finalState?.iterations[0].status).toBe('error');
      expect(finalState?.iterations[1].status).toBe('completed');
    });
  });

  describe('resume', () => {
    it('should throw when no state to resume', async () => {
      const orchestrator = new Orchestrator(testDir);
      await expect(orchestrator.resume()).rejects.toThrow('No external Ralph loop to resume');
    });

    it('should resume from saved state', { timeout: 10000 }, async () => {
      const orchestrator = new Orchestrator(testDir);

      // Create initial state
      orchestrator.stateManager.initialize({
        objective: 'Resumable task',
        completionCriteria: 'Done',
        maxIterations: 5,
        enablePIDControl: false,
        enableOverseer: false,
        enableSemanticMemory: false,
        crossTask: false,
        enableAnalytics: false,
        enableBestOutput: false,
        enableEarlyStopping: false,
        enableClaudeIntelligence: false,
        enableSnapshots: false,
        enableCheckpoints: false,
      });

      orchestrator.stateManager.update({ status: 'paused', currentIteration: 1 });

      // Add previous iteration
      orchestrator.stateManager.addIteration({
        number: 1,
        sessionId: 'test',
        promptFile: 'prompts/001.md',
        stdoutFile: 'outputs/001-stdout.log',
        stderrFile: 'outputs/001-stderr.log',
        exitCode: 0,
        duration: 1000,
        status: 'incomplete',
        analysis: { completed: false, shouldContinue: true },
        learnings: ['First attempt'],
        filesModified: ['src/partial.ts'],
        progress: '50%',
      });

      vi.spyOn(orchestrator.sessionLauncher, 'launch').mockResolvedValue({
        exitCode: 0,
        killed: false,
        pid: 12345,
      });

      vi.spyOn(orchestrator.outputAnalyzer, 'analyze').mockResolvedValue({
        completed: true,
        success: true,
        failureClass: null,
        completionPercentage: 100,
        shouldContinue: false,
        learnings: 'Completed after resume',
        artifactsModified: ['src/finished.ts'],
        blockers: [],
        nextApproach: '',
      });

      vi.spyOn(orchestrator.stateManager, 'setCurrentPid').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await orchestrator.resume();

      expect(result.success).toBe(true);
      expect(result.iterations).toBe(2);

      const finalState = orchestrator.stateManager.load();
      expect(finalState?.status).toBe('completed');
      expect(finalState?.iterations).toHaveLength(2);
    });
  });

  describe('getStatus', () => {
    it('should return null when no state', () => {
      const orchestrator = new Orchestrator(testDir);
      expect(orchestrator.getStatus()).toBeNull();
    });

    it('should return current status', () => {
      const orchestrator = new Orchestrator(testDir);
      orchestrator.stateManager.initialize({
        objective: 'Task',
        completionCriteria: 'Done',
      });

      const status = orchestrator.getStatus();
      expect(status).not.toBeNull();
      expect(status?.objective).toBe('Task');
      expect(status?.status).toBe('running');
    });
  });

  describe('completion report', () => {
    it('should generate completion report on success', { timeout: 10000 }, async () => {
      const orchestrator = new Orchestrator(testDir);

      vi.spyOn(orchestrator.sessionLauncher, 'launch').mockResolvedValue({
        exitCode: 0,
        killed: false,
        pid: 12345,
      });

      vi.spyOn(orchestrator.outputAnalyzer, 'analyze').mockResolvedValue({
        completed: true,
        success: true,
        failureClass: null,
        completionPercentage: 100,
        shouldContinue: false,
        learnings: 'All tests pass',
        artifactsModified: ['src/feature.ts'],
        blockers: [],
        nextApproach: '',
      });

      vi.spyOn(orchestrator.stateManager, 'setCurrentPid').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await orchestrator.execute({
        objective: 'Implement feature',
        completionCriteria: 'Tests pass',
        maxIterations: 5,
        enablePIDControl: false,
        enableOverseer: false,
        enableSemanticMemory: false,
        crossTask: false,
        enableAnalytics: false,
        enableBestOutput: false,
        enableEarlyStopping: false,
        enableClaudeIntelligence: false,
        enableSnapshots: false,
        enableCheckpoints: false,
      });

      const reportPath = join(orchestrator.stateManager.getStateDir(), 'completion-report.md');
      expect(existsSync(reportPath)).toBe(true);

      const report = readFileSync(reportPath, 'utf8');
      expect(report).toContain('External Ralph Loop Completion Report');
      expect(report).toContain('Implement feature');
      expect(report).toContain('Tests pass');
      expect(report).toContain('SUCCESS');
    });
  });

  describe('snapshots integration', () => {
    // Regression test: orchestrator was passing objects to SnapshotManager
    // where string paths were expected, causing:
    // "The path argument must be of type string. Received an instance of Object"

    it('should capture pre/post snapshots without type errors when enableSnapshots is true', { timeout: 15000 }, async () => {
      const orchestrator = new Orchestrator(testDir);

      // Initialize a git repo so snapshots can capture git state
      const { execSync } = await import('child_process');
      try {
        execSync('git init', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });
        execSync('git config user.email "test@test.com"', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });
        execSync('git config user.name "Test"', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });
        const { writeFileSync } = await import('fs');
        writeFileSync(join(testDir, 'init.txt'), 'init');
        execSync('git add .', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });
        execSync('git commit -m "init"', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });
      } catch {
        // git not available, skip
        return;
      }

      vi.spyOn(orchestrator.sessionLauncher, 'launch').mockResolvedValue({
        exitCode: 0,
        killed: false,
        pid: 12345,
      });

      vi.spyOn(orchestrator.outputAnalyzer, 'analyze').mockResolvedValue({
        completed: true,
        success: true,
        failureClass: null,
        completionPercentage: 100,
        shouldContinue: false,
        learnings: 'Done',
        artifactsModified: [],
        blockers: [],
        nextApproach: '',
      });

      vi.spyOn(orchestrator.stateManager, 'setCurrentPid').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      // This was the exact call path that crashed before the fix
      const result = await orchestrator.execute({
        objective: 'Test with snapshots',
        completionCriteria: 'Done',
        maxIterations: 1,
        enablePIDControl: false,
        enableOverseer: false,
        enableSemanticMemory: false,
        crossTask: false,
        enableAnalytics: false,
        enableBestOutput: false,
        enableEarlyStopping: false,
        enableClaudeIntelligence: false,
        enableSnapshots: true,
        enableCheckpoints: false,
      });

      expect(result.success).toBe(true);

      // Verify snapshot files were created with proper paths (not [object Object])
      const stateDir = join(testDir, '.aiwg', 'ralph-external');
      const iterDirs = existsSync(join(stateDir, 'iterations'))
        ? (await import('fs')).readdirSync(join(stateDir, 'iterations'))
        : [];

      if (iterDirs.length > 0) {
        const iterDir = join(stateDir, 'iterations', iterDirs[0]);
        const preSnapshotPath = join(iterDir, 'pre-snapshot.json');
        if (existsSync(preSnapshotPath)) {
          const preSnapshot = JSON.parse(readFileSync(preSnapshotPath, 'utf8'));
          expect(preSnapshot.timestamp).toBeDefined();
          expect(preSnapshot.git).toBeDefined();
        }
      }
    });
  });

  describe('abort', () => {
    it('should set aborted flag and call sessionLauncher.kill', () => {
      const orchestrator = new Orchestrator(testDir);
      const killSpy = vi.spyOn(orchestrator.sessionLauncher, 'kill').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      orchestrator.abort();

      expect(orchestrator.aborted).toBe(true);
      expect(killSpy).toHaveBeenCalled();
    });
  });

  describe('full launch e2e', () => {
    // These tests use a real child_process.spawn() with a stub Node script
    // instead of mocking sessionLauncher.launch(). This exercises the full
    // pipeline: orchestrator → prompt generation → file write → real spawn →
    // stdout/stderr capture → output analysis via pattern matching → state update.

    it('should spawn real process, capture output, and complete one-shot task', { timeout: 30000 }, async () => {
      // Register stub provider so orchestrator.execute() uses it via createProvider('stub')
      const { registerStubProvider } = await import('../fixtures/stub-provider-adapter.mjs');
      registerStubProvider();

      const orchestrator = new Orchestrator(testDir);

      vi.spyOn(orchestrator.stateManager, 'setCurrentPid').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await orchestrator.execute({
        objective: 'Reply with OK',
        completionCriteria: 'Output contains OK',
        maxIterations: 1,
        provider: 'stub',
        enableSnapshots: false,
        enableCheckpoints: false,
        enablePIDControl: false,
        enableOverseer: false,
        enableSemanticMemory: false,
        enableClaudeIntelligence: false,
        crossTask: false,
        enableAnalytics: false,
        enableBestOutput: false,
        enableEarlyStopping: false,
      });

      // Verify orchestrator result
      expect(result.success).toBe(true);
      expect(result.iterations).toBe(1);
      expect(result.loopId).toBeDefined();

      // Verify state file exists and is correct
      const state = orchestrator.stateManager.load();
      expect(state?.status).toBe('completed');
      expect(state?.iterations).toHaveLength(1);
      expect(state?.iterations[0].exitCode).toBe(0);

      // Verify file artifacts on disk — stateDir follows the loop through archiving
      const stateDir = orchestrator.stateManager.getStateDir();
      expect(existsSync(join(stateDir, 'session-state.json'))).toBe(true);

      // Verify prompt was written
      const promptPath = state?.iterations[0].promptFile;
      expect(promptPath).toBeDefined();
      if (promptPath && existsSync(promptPath)) {
        const prompt = readFileSync(promptPath, 'utf8');
        expect(prompt).toContain('Reply with OK');
      }

      // Verify stdout was captured from the real process
      const stdoutPath = state?.iterations[0].stdoutFile;
      expect(stdoutPath).toBeDefined();
      if (stdoutPath && existsSync(stdoutPath)) {
        const stdout = readFileSync(stdoutPath, 'utf8');
        expect(stdout).toContain('ralph_external_completion');
        expect(stdout).toContain('"success":true');
      }

      // Verify stderr file exists via stateManager (handles archive-dir relocation)
      const stderrPath = state?.iterations[0].stderrFile;
      expect(stderrPath).toBeDefined();
      const currentStderrPath = orchestrator.stateManager.getOutputPaths(1).stderr;
      expect(existsSync(currentStderrPath)).toBe(true);

      // Verify completion report was generated
      const reportPath = join(stateDir, 'completion-report.md');
      expect(existsSync(reportPath)).toBe(true);
      const report = readFileSync(reportPath, 'utf8');
      expect(report).toContain('Reply with OK');
    });

    it('should handle non-zero exit from spawned process', { timeout: 30000 }, async () => {
      // Register stub provider with --stub-fail flag
      const { registerStubProvider } = await import('../fixtures/stub-provider-adapter.mjs');
      registerStubProvider(['--stub-fail']);

      const orchestrator = new Orchestrator(testDir);

      vi.spyOn(orchestrator.stateManager, 'setCurrentPid').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await orchestrator.execute({
        objective: 'Task that will fail',
        completionCriteria: 'Should not complete',
        maxIterations: 1,
        provider: 'stub',
        enableSnapshots: false,
        enableCheckpoints: false,
        enablePIDControl: false,
        enableOverseer: false,
        enableSemanticMemory: false,
        enableClaudeIntelligence: false,
        crossTask: false,
        enableAnalytics: false,
        enableBestOutput: false,
        enableEarlyStopping: false,
      });

      // With maxIterations: 1 and no completion marker, should reach limit
      expect(result.success).toBe(false);
      expect(result.iterations).toBe(1);

      // Verify state reflects the failure
      const state = orchestrator.stateManager.load();
      expect(state?.iterations).toHaveLength(1);
      expect(state?.iterations[0].exitCode).toBe(1);

      // Verify stdout was still captured (stub emits lines before exiting)
      const stdoutPath = state?.iterations[0].stdoutFile;
      if (stdoutPath && existsSync(stdoutPath)) {
        const stdout = readFileSync(stdoutPath, 'utf8');
        expect(stdout).toContain('Working on the task');
        // Should NOT contain completion marker
        expect(stdout).not.toContain('ralph_external_completion');
      }
    });

    it('should handle crash output from spawned process', { timeout: 30000 }, async () => {
      // Register stub provider with --stub-crash flag
      const { registerStubProvider } = await import('../fixtures/stub-provider-adapter.mjs');
      registerStubProvider(['--stub-crash']);

      const orchestrator = new Orchestrator(testDir);

      vi.spyOn(orchestrator.stateManager, 'setCurrentPid').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await orchestrator.execute({
        objective: 'Task that crashes',
        completionCriteria: 'Should not complete',
        maxIterations: 1,
        provider: 'stub',
        enableSnapshots: false,
        enableCheckpoints: false,
        enablePIDControl: false,
        enableOverseer: false,
        enableSemanticMemory: false,
        enableClaudeIntelligence: false,
        crossTask: false,
        enableAnalytics: false,
        enableBestOutput: false,
        enableEarlyStopping: false,
      });

      expect(result.success).toBe(false);
      expect(result.iterations).toBe(1);

      // Verify stderr was captured
      const state = orchestrator.stateManager.load();
      const stderrPath = state?.iterations[0].stderrFile;
      if (stderrPath && existsSync(stderrPath)) {
        const stderr = readFileSync(stderrPath, 'utf8');
        expect(stderr).toContain('unexpected termination');
      }
    });
  });
});
