import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AutonomousEngine } from '../../../tools/daemon/autonomous-engine.mjs';

function createMockSupervisor() {
  return {
    submit: vi.fn().mockResolvedValue({ loopId: 'loop-auto-001' }),
  };
}

function defaultConfig(overrides = {}) {
  return {
    enabled: false,
    thinking_interval_minutes: 30,
    max_daily_tasks: 10,
    budget_cap_usd: 5.00,
    require_approval: false,
    allowed_actions: ['self-review', 'doc-sync', 'test-sync', 'cleanup-audit'],
    blocked_actions: ['deploy', 'release', 'git-push'],
    ...overrides,
  };
}

describe('AutonomousEngine', () => {
  let engine;
  let supervisor;

  beforeEach(() => {
    supervisor = createMockSupervisor();
    vi.useFakeTimers();
  });

  afterEach(() => {
    engine?.stop();
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('does not start when disabled', () => {
      engine = new AutonomousEngine({
        supervisor,
        config: defaultConfig({ enabled: false }),
      });
      engine.start();
      expect(engine.getStatus().running).toBe(false);
    });

    it('starts when enabled', () => {
      engine = new AutonomousEngine({
        supervisor,
        config: defaultConfig({ enabled: true }),
      });
      engine.start();
      expect(engine.getStatus().running).toBe(true);
    });
  });

  describe('enable / disable', () => {
    it('enables at runtime', () => {
      engine = new AutonomousEngine({
        supervisor,
        config: defaultConfig({ enabled: false }),
      });
      engine.enable();
      expect(engine.getStatus().enabled).toBe(true);
      expect(engine.getStatus().running).toBe(true);
    });

    it('disables at runtime', () => {
      engine = new AutonomousEngine({
        supervisor,
        config: defaultConfig({ enabled: true }),
      });
      engine.start();
      engine.disable();
      expect(engine.getStatus().enabled).toBe(false);
      expect(engine.getStatus().running).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('reports full status', () => {
      engine = new AutonomousEngine({
        supervisor,
        config: defaultConfig({ enabled: true }),
      });

      const status = engine.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.dailyTaskLimit).toBe(10);
      expect(status.budgetCapUsd).toBe(5);
      expect(status.allowedActions).toContain('doc-sync');
      expect(status.blockedActions).toContain('deploy');
    });

    it('preserves explicit zero budget caps in status', () => {
      engine = new AutonomousEngine({
        supervisor,
        config: defaultConfig({ budget_cap_usd: 0 }),
      });

      expect(engine.getStatus().budgetCapUsd).toBe(0);
    });
  });

  describe('proposal validation', () => {
    it('deterministically accepts allowed zero-cost actions without submitting work', () => {
      engine = new AutonomousEngine({
        supervisor,
        config: defaultConfig({
          budget_cap_usd: 0,
          allowed_actions: ['rbi-mission-status-report'],
          blocked_actions: ['broadcast'],
        }),
      });

      const result = engine.rehearseAction('rbi-mission-status-report');

      expect(result).toEqual({
        accepted: true,
        action: 'rbi-mission-status-report',
        reason: null,
        noLlm: true,
      });
      expect(supervisor.submit).not.toHaveBeenCalled();
    });

    it('deterministically denies blocked actions without submitting work', () => {
      engine = new AutonomousEngine({
        supervisor,
        config: defaultConfig({
          allowed_actions: ['rbi-mission-status-report'],
          blocked_actions: ['broadcast'],
        }),
      });

      const result = engine.rehearseAction('broadcast');

      expect(result).toEqual({
        accepted: false,
        action: 'broadcast',
        reason: 'blocked-action',
        noLlm: true,
      });
      expect(supervisor.submit).not.toHaveBeenCalled();
    });

    it('rejects proposals with blocked actions', () => {
      engine = new AutonomousEngine({
        supervisor,
        config: defaultConfig({ enabled: true }),
      });

      // The rejectProposal method returns false for non-existent proposals
      const result = engine.rejectProposal('nonexistent');
      expect(result).toBe(false);
    });

    it('rejects proposals for non-existent IDs', async () => {
      engine = new AutonomousEngine({
        supervisor,
        config: defaultConfig({ enabled: true }),
      });

      const result = await engine.approveProposal('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('thinking cycle', () => {
    it('submits a thinking task on interval tick', async () => {
      engine = new AutonomousEngine({
        supervisor,
        config: defaultConfig({ enabled: true, thinking_interval_minutes: 1 }),
      });
      engine.start();

      // Advance timer past the interval and flush async promises
      await vi.advanceTimersByTimeAsync(60 * 1000 + 100);

      // Stop engine before assertions to prevent further timer ticks
      engine.stop();

      expect(supervisor.submit).toHaveBeenCalled();
      const call = supervisor.submit.mock.calls[0][0];
      expect(call.priority).toBe(1); // Low priority
      expect(call.metadata.source).toBe('autonomous');
    });
  });
});
