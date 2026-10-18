/**
 * Tests for DaemonSupervisor
 *
 * @implements Issue #513
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { DaemonSupervisor } from '../../../tools/ralph-external/daemon-supervisor.mjs';
import { CircuitState } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import { sampleWorkerIdentity } from '../../../tools/ralph-external/process-monitor.mjs';

/**
 * Stub AgentSupervisor for isolated testing.
 * Simulates submit/cancel/shutdown without spawning real processes.
 */
class StubAgentSupervisor extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map();
    this.taskCounter = 0;
    this.shutdownCalled = false;
  }

  submit(prompt, options = {}) {
    const id = `task-${++this.taskCounter}`;
    const task = { id, prompt, ...options, state: 'queued' };
    this.tasks.set(id, task);

    // Simulate async start
    queueMicrotask(() => {
      this.emit('task:started', { taskId: id, pid: 10000 + this.taskCounter });
    });

    return task;
  }

  cancel(taskId) {
    if (this.tasks.has(taskId)) {
      this.tasks.delete(taskId);
      this.emit('task:cancelled', { taskId });
      return true;
    }
    return false;
  }

  async shutdown(timeoutMs) {
    this.shutdownCalled = true;
    this.tasks.clear();
  }

  // Test helpers
  completeTask(taskId) {
    this.tasks.delete(taskId);
    this.emit('task:completed', { taskId, result: 'done' });
  }

  failTask(taskId, error = 'test error') {
    this.tasks.delete(taskId);
    this.emit('task:failed', { taskId, error });
  }
}

describe('DaemonSupervisor', () => {
  let stubSupervisor;
  let daemon;

  beforeEach(() => {
    vi.useFakeTimers();
    stubSupervisor = new StubAgentSupervisor();
    daemon = new DaemonSupervisor({
      agentSupervisor: stubSupervisor,
      maxConcurrent: 4,
      maxQueueDepth: 5,
      restartIntensity: { maxRestarts: 3, windowMs: 60_000 },
      dailyBudgetUsd: 100,
      circuitBreaker: { failureThreshold: 3, cooldownMs: 5000 },
    });
  });

  afterEach(() => {
    daemon.circuitBreaker.destroy();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should require agentSupervisor', () => {
      expect(() => new DaemonSupervisor({})).toThrow('requires an agentSupervisor');
    });

    it('should initialize with defaults', () => {
      const d = new DaemonSupervisor({ agentSupervisor: stubSupervisor });
      expect(d.maxConcurrent).toBe(4);
      expect(d.maxQueueDepth).toBe(20);
      expect(d.dailyBudgetUsd).toBe(0);
      d.circuitBreaker.destroy();
    });

    it('should accept custom configuration', () => {
      expect(daemon.maxConcurrent).toBe(4);
      expect(daemon.maxQueueDepth).toBe(5);
      expect(daemon.dailyBudgetUsd).toBe(100);
    });
  });

  describe('submit()', () => {
    it('should submit and start a loop immediately when under concurrency', () => {
      const result = daemon.submit({ loopId: 'loop-1', prompt: 'test task' });
      expect(result.loopId).toBe('loop-1');
      expect(result.queued).toBe(false);
      expect(result.position).toBe(0);
    });

    it('should generate loopId when not provided', () => {
      const result = daemon.submit({ prompt: 'test' });
      expect(result.loopId).toMatch(/^loop-/);
    });

    it('should emit loop:started event', () => {
      const events = [];
      daemon.on('loop:started', (evt) => events.push(evt));
      daemon.submit({ loopId: 'loop-1', prompt: 'test' });
      expect(events).toHaveLength(1);
      expect(events[0].loopId).toBe('loop-1');
    });
  });

  describe('concurrency cap', () => {
    it('should queue loops when at concurrency limit', () => {
      for (let i = 1; i <= 4; i++) {
        daemon.submit({ loopId: `loop-${i}`, prompt: `task ${i}` });
      }

      // 5th should be queued
      const result = daemon.submit({ loopId: 'loop-5', prompt: 'task 5' });
      expect(result.queued).toBe(true);
      expect(result.position).toBe(1);

      const status = daemon.status();
      expect(status.concurrencyUsed).toBe(4);
      expect(status.queueDepth).toBe(1);
    });

    it('should drain queue when a running loop completes', () => {
      // Fill concurrency
      for (let i = 1; i <= 4; i++) {
        daemon.submit({ loopId: `loop-${i}`, prompt: `task ${i}` });
      }

      // Queue one more
      daemon.submit({ loopId: 'loop-5', prompt: 'task 5' });
      expect(daemon.status().queueDepth).toBe(1);

      // Complete first task
      stubSupervisor.completeTask('task-1');

      // Queue should have drained
      expect(daemon.status().queueDepth).toBe(0);
      expect(daemon.status().concurrencyUsed).toBe(4); // 3 original + 1 from queue
    });
  });

  describe('queue overflow', () => {
    it('should reject when queue is full', () => {
      // Fill concurrency (4 running)
      for (let i = 1; i <= 4; i++) {
        daemon.submit({ loopId: `loop-${i}`, prompt: `task ${i}` });
      }

      // Fill queue (maxQueueDepth = 5)
      for (let i = 5; i <= 9; i++) {
        daemon.submit({ loopId: `loop-${i}`, prompt: `task ${i}` });
      }

      // 10th should be rejected (queue full)
      expect(() => {
        daemon.submit({ loopId: 'loop-10', prompt: 'task 10' });
      }).toThrow(/Queue full/);
    });

    it('should emit loop:rejected event on overflow', () => {
      const events = [];
      daemon.on('loop:rejected', (evt) => events.push(evt));

      // Fill concurrency + queue
      for (let i = 1; i <= 9; i++) {
        daemon.submit({ loopId: `loop-${i}`, prompt: `task ${i}` });
      }

      // Overflow
      expect(() => {
        daemon.submit({ loopId: 'loop-10', prompt: 'task 10' });
      }).toThrow();

      expect(events).toHaveLength(1);
      expect(events[0].reason).toBe('queue full');
    });
  });

  describe('priority queue', () => {
    it('should process higher priority items first', () => {
      // Fill concurrency
      for (let i = 1; i <= 4; i++) {
        daemon.submit({ loopId: `loop-${i}`, prompt: `task ${i}` });
      }

      // Queue items with different priorities
      daemon.submit({ loopId: 'low', prompt: 'low', priority: 1 });
      daemon.submit({ loopId: 'high', prompt: 'high', priority: 10 });
      daemon.submit({ loopId: 'mid', prompt: 'mid', priority: 5 });

      const status = daemon.status();
      const priorities = status.queued.map(q => q.priority);
      expect(priorities).toEqual([10, 5, 1]); // sorted high to low
    });
  });

  describe('restart intensity', () => {
    it('should restart a failed loop within intensity limits', () => {
      const events = [];
      daemon.on('loop:recovered', (evt) => events.push(evt));

      daemon.submit({ loopId: 'loop-1', prompt: 'test' });

      // First failure — should restart
      stubSupervisor.failTask('task-1', 'crash');
      expect(events).toHaveLength(1);
      expect(events[0].restarting).toBe(true);
    });

    it('should mark loop as permanently failed after exceeding intensity', () => {
      const failEvents = [];
      daemon.on('loop:failed', (evt) => failEvents.push(evt));

      daemon.submit({ loopId: 'loop-1', prompt: 'test' });

      // Fail 3 times within window (maxRestarts=3)
      stubSupervisor.failTask('task-1', 'crash 1');
      // Task-2 is the restart
      stubSupervisor.failTask('task-2', 'crash 2');
      // Task-3 is second restart
      stubSupervisor.failTask('task-3', 'crash 3');

      // After 3 failures, should be permanently failed
      expect(failEvents.some(e => e.permanent === true)).toBe(true);
      expect(daemon.status().permanentlyFailed).toContain('loop-1');
    });

    it('should reject submissions for permanently failed loops', () => {
      daemon.submit({ loopId: 'loop-1', prompt: 'test' });

      // Fail until permanently failed
      for (let i = 1; i <= 3; i++) {
        stubSupervisor.failTask(`task-${i}`, `crash ${i}`);
      }

      expect(() => {
        daemon.submit({ loopId: 'loop-1', prompt: 'retry' });
      }).toThrow(/permanently failed/);
    });
  });

  describe('circuit breaker integration', () => {
    it('should trip circuit breaker on consecutive failures', () => {
      const trips = [];
      daemon.on('circuit:trip', (evt) => trips.push(evt));

      // Submit and fail 3 different loops (threshold = 3)
      for (let i = 1; i <= 3; i++) {
        daemon.submit({ loopId: `loop-${i}`, prompt: `test ${i}` });
      }

      // Disable restarts for this test by using unique loopIds
      daemon._restartHistory = new Map(); // clear

      // Fail each one (they don't restart because we use different IDs each time)
      // Need to make them permanently failed first so they don't restart
      for (let i = 1; i <= 3; i++) {
        // Pre-fill restart history to prevent restarts
        daemon._permanentlyFailed.add(`loop-${i}`);
        stubSupervisor.failTask(`task-${i}`, `error ${i}`);
      }

      expect(trips).toHaveLength(1);
      expect(daemon.circuitBreaker.getState().state).toBe(CircuitState.OPEN);
    });

    it('should reject submissions when circuit is open', () => {
      // Manually trip the breaker
      for (let i = 0; i < 3; i++) {
        daemon.circuitBreaker.recordFailure();
      }

      expect(() => {
        daemon.submit({ loopId: 'test', prompt: 'test' });
      }).toThrow(/Circuit breaker/);
    });
  });

  describe('budget gate', () => {
    it('should block submission when budget exceeded', () => {
      daemon.recordCost('loop-0', 100); // use entire budget

      expect(() => {
        daemon.submit({ loopId: 'loop-1', prompt: 'test', estimatedCostUsd: 1 });
      }).toThrow(/Daily budget exceeded/);
    });

    it('should emit budget:exceeded event', () => {
      const events = [];
      daemon.on('budget:exceeded', (evt) => events.push(evt));

      daemon.recordCost('loop-0', 100);

      expect(() => {
        daemon.submit({ loopId: 'loop-1', prompt: 'test', estimatedCostUsd: 1 });
      }).toThrow();

      expect(events).toHaveLength(1);
      expect(events[0].budgetUsed).toBe(100);
    });

    it('should emit budget:warning at 90%', () => {
      const warnings = [];
      daemon.on('budget:warning', (evt) => warnings.push(evt));

      daemon.recordCost('loop-0', 91); // 91% of $100

      daemon.submit({ loopId: 'loop-1', prompt: 'test' });
      expect(warnings).toHaveLength(1);
      expect(parseFloat(warnings[0].percentUsed)).toBeGreaterThanOrEqual(90);
    });

    it('should allow unlimited budget when dailyBudgetUsd is 0', () => {
      const unlimitedDaemon = new DaemonSupervisor({
        agentSupervisor: stubSupervisor,
        dailyBudgetUsd: 0,
      });

      unlimitedDaemon.recordCost('x', 999999);
      expect(() => {
        unlimitedDaemon.submit({ loopId: 'test', prompt: 'test' });
      }).not.toThrow();

      unlimitedDaemon.circuitBreaker.destroy();
    });

    it('should report budget in status', () => {
      daemon.recordCost('loop-0', 42.50);
      const status = daemon.status();
      expect(status.budgetUsed).toBe(42.50);
      expect(status.budgetLimit).toBe(100);
    });
  });

  describe('process group kill', () => {
    it.each([0, 1, -1, 1.5, NaN, undefined, process.pid, sampleWorkerIdentity(process.pid)?.pgid])('refuses unsafe group %s', pid => {
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
      try {
        daemon.submit({ loopId: 'loop-1', prompt: 'test' });
        daemon._running.get('loop-1').pid = pid;
        expect(daemon.killProcessGroup('loop-1')).toBe(false);
        expect(killSpy).not.toHaveBeenCalled();
      } finally { killSpy.mockRestore(); }
    });
    it('should send signal to negative PID', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {});

      daemon.submit({ loopId: 'loop-1', prompt: 'test' });

      // Simulate PID assignment
      daemon._running.get('loop-1').pid = 12345;

      const result = daemon.killProcessGroup('loop-1', 'SIGTERM');
      expect(result).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');

      killSpy.mockRestore();
    });

    it('should return false for unknown loop', () => {
      expect(daemon.killProcessGroup('nonexistent')).toBe(false);
    });

    it('should handle ESRCH (process already dead)', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        const err = new Error('kill ESRCH');
        err.code = 'ESRCH';
        throw err;
      });

      daemon.submit({ loopId: 'loop-1', prompt: 'test' });
      daemon._running.get('loop-1').pid = 12345;

      const result = daemon.killProcessGroup('loop-1');
      expect(result).toBe(false);

      killSpy.mockRestore();
    });
  });

  describe('cancel()', () => {
    it('should cancel a queued loop', () => {
      // Fill concurrency
      for (let i = 1; i <= 4; i++) {
        daemon.submit({ loopId: `loop-${i}`, prompt: `task ${i}` });
      }
      daemon.submit({ loopId: 'queued-1', prompt: 'queued' });

      const result = daemon.cancel('queued-1');
      expect(result).toBe(true);
      expect(daemon.status().queueDepth).toBe(0);
    });

    it('should cancel a running loop via AgentSupervisor', () => {
      daemon.submit({ loopId: 'loop-1', prompt: 'test' });
      const result = daemon.cancel('loop-1');
      expect(result).toBe(true);
    });

    it('should return false for unknown loop', () => {
      expect(daemon.cancel('nonexistent')).toBe(false);
    });
  });

  describe('status()', () => {
    it('should return comprehensive status', () => {
      daemon.submit({ loopId: 'loop-1', prompt: 'test' });
      const status = daemon.status();

      expect(status).toHaveProperty('running');
      expect(status).toHaveProperty('queued');
      expect(status).toHaveProperty('circuitState');
      expect(status).toHaveProperty('concurrencyUsed');
      expect(status).toHaveProperty('concurrencyMax');
      expect(status).toHaveProperty('queueDepth');
      expect(status).toHaveProperty('queueMax');
      expect(status).toHaveProperty('budgetUsed');
      expect(status).toHaveProperty('budgetLimit');
      expect(status).toHaveProperty('permanentlyFailed');

      expect(status.concurrencyUsed).toBe(1);
      expect(status.concurrencyMax).toBe(4);
    });
  });

  describe('shutdown()', () => {
    it('should drain queue and delegate to AgentSupervisor', async () => {
      // Fill concurrency + queue
      for (let i = 1; i <= 5; i++) {
        daemon.submit({ loopId: `loop-${i}`, prompt: `task ${i}` });
      }

      const rejections = [];
      daemon.on('loop:rejected', (evt) => rejections.push(evt));

      await daemon.shutdown(1000);

      expect(stubSupervisor.shutdownCalled).toBe(true);
      expect(rejections).toHaveLength(1); // the queued one
    });

    it('should reject new submissions after shutdown starts', async () => {
      const shutdownPromise = daemon.shutdown(1000);

      expect(() => {
        daemon.submit({ loopId: 'late', prompt: 'test' });
      }).toThrow(/shutting down/);

      await shutdownPromise;
    });
  });
});
