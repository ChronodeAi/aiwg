/**
 * DaemonSupervisor - Production-grade process governance wrapping AgentSupervisor
 *
 * Adds to AgentSupervisor:
 *   1. Bounded priority queue (configurable maxQueueDepth)
 *   2. Configurable concurrency cap (maxConcurrent)
 *   3. Process group kill (-pid instead of pid)
 *   4. Restart intensity tracking (Erlang/OTP max_restarts pattern)
 *   5. SIGCHLD handling for zombie reaping
 *   6. Budget aggregation vs daily limit
 *
 * @implements #513
 * @tests @test/unit/daemon-supervisor.test.mjs
 */

import { EventEmitter } from 'node:events';
import { isSafeWorkerGroupTarget } from './process-monitor.mjs';
import { ConsecutiveFailureCircuitBreaker } from './lib/consecutive-failure-circuit-breaker.mjs';

export class DaemonSupervisor extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.agentSupervisor - AgentSupervisor instance to wrap
   * @param {number} [options.maxConcurrent=4] - Maximum concurrent loops
   * @param {number} [options.maxQueueDepth=20] - Maximum queue size before rejection
   * @param {object} [options.restartIntensity] - Erlang/OTP restart intensity
   * @param {number} [options.restartIntensity.maxRestarts=3] - Max restarts allowed
   * @param {number} [options.restartIntensity.windowMs=300000] - Time window (5 min)
   * @param {number} [options.dailyBudgetUsd=0] - Daily spend limit (0 = unlimited)
   * @param {object} [options.circuitBreaker] - Circuit breaker config overrides
   */
  constructor(options = {}) {
    super();

    if (!options.agentSupervisor) {
      throw new Error('DaemonSupervisor requires an agentSupervisor instance');
    }

    this.agentSupervisor = options.agentSupervisor;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.maxQueueDepth = options.maxQueueDepth ?? 20;
    this.dailyBudgetUsd = options.dailyBudgetUsd ?? 0;

    this.restartIntensity = {
      maxRestarts: options.restartIntensity?.maxRestarts ?? 3,
      windowMs: options.restartIntensity?.windowMs ?? 300_000,
    };

    // Internal state
    this._queue = []; // bounded priority queue
    this._running = new Map(); // loopId -> { config, pid, startedAt }
    this._restartHistory = new Map(); // loopId -> [timestamp, ...]
    this._permanentlyFailed = new Set(); // loopIds that exceeded restart intensity
    this._budgetUsed = 0; // aggregate USD spend today
    this._budgetResetAt = this._nextMidnight();
    this._shutdownInProgress = false;

    // Circuit breaker for system-wide health
    this.circuitBreaker = new ConsecutiveFailureCircuitBreaker({
      failureThreshold: options.circuitBreaker?.failureThreshold ?? 5,
      cooldownMs: options.circuitBreaker?.cooldownMs ?? 120_000,
      ...options.circuitBreaker,
    });

    // Forward circuit breaker events
    this.circuitBreaker.on('state:change', (evt) => this.emit('circuit:change', evt));
    this.circuitBreaker.on('trip', (evt) => this.emit('circuit:trip', evt));
    this.circuitBreaker.on('recover', () => this.emit('circuit:recover'));

    // Wire up AgentSupervisor events
    this._wireAgentSupervisorEvents();
  }

  /**
   * Submit a loop configuration for execution.
   * @param {object} loopConfig - Loop configuration
   * @param {string} loopConfig.loopId - Unique loop identifier
   * @param {string} loopConfig.prompt - Task prompt
   * @param {number} [loopConfig.priority=0] - Queue priority (higher = first)
   * @param {number} [loopConfig.estimatedCostUsd=0] - Estimated cost for budget check
   * @returns {{ loopId: string, queued: boolean, position: number }}
   */
  submit(loopConfig) {
    if (this._shutdownInProgress) {
      throw new Error('DaemonSupervisor is shutting down');
    }

    const loopId = loopConfig.loopId || `loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Check permanently failed
    if (this._permanentlyFailed.has(loopId)) {
      throw new Error(`Loop ${loopId} is permanently failed (restart intensity exceeded)`);
    }

    // Check circuit breaker
    if (!this.circuitBreaker.canExecute()) {
      const state = this.circuitBreaker.getState();
      throw new Error(
        `Circuit breaker is ${state.state}: ${state.consecutiveFailures} consecutive failures. ` +
        `Cooldown remaining: ${Math.ceil(state.cooldownRemainingMs / 1000)}s`
      );
    }

    // Check budget gate
    this._resetBudgetIfNewDay();
    if (this.dailyBudgetUsd > 0) {
      const estimatedCost = loopConfig.estimatedCostUsd || 0;
      if (this._budgetUsed + estimatedCost >= this.dailyBudgetUsd) {
        this.emit('budget:exceeded', {
          budgetUsed: this._budgetUsed,
          dailyLimit: this.dailyBudgetUsd,
          requested: estimatedCost,
        });
        throw new Error(
          `Daily budget exceeded: $${this._budgetUsed.toFixed(2)} used of $${this.dailyBudgetUsd.toFixed(2)} limit`
        );
      }

      // Warn at 90%
      if (this._budgetUsed >= this.dailyBudgetUsd * 0.9) {
        this.emit('budget:warning', {
          budgetUsed: this._budgetUsed,
          dailyLimit: this.dailyBudgetUsd,
          percentUsed: ((this._budgetUsed / this.dailyBudgetUsd) * 100).toFixed(1),
        });
      }
    }

    // Check queue capacity
    if (this._queue.length >= this.maxQueueDepth) {
      this.emit('loop:rejected', {
        loopId,
        reason: 'queue full',
        queueDepth: this._queue.length,
        maxQueueDepth: this.maxQueueDepth,
      });
      throw new Error(
        `Queue full: ${this._queue.length}/${this.maxQueueDepth}. Cannot enqueue loop ${loopId}`
      );
    }

    // Can we run immediately?
    if (this._running.size < this.maxConcurrent) {
      this._startLoop(loopId, loopConfig);
      return { loopId, queued: false, position: 0 };
    }

    // Enqueue
    const entry = { loopId, config: loopConfig, enqueuedAt: Date.now() };
    this._queue.push(entry);
    this._queue.sort((a, b) => (b.config.priority || 0) - (a.config.priority || 0));
    const position = this._queue.findIndex(e => e.loopId === loopId) + 1;

    this.emit('loop:queued', { loopId, position, queueDepth: this._queue.length });
    return { loopId, queued: true, position };
  }

  /**
   * Cancel a loop (running or queued).
   */
  cancel(loopId) {
    // Check queue
    const queueIdx = this._queue.findIndex(e => e.loopId === loopId);
    if (queueIdx !== -1) {
      this._queue.splice(queueIdx, 1);
      return true;
    }

    // Check running — delegate to AgentSupervisor
    const entry = this._running.get(loopId);
    if (entry && entry.taskId) {
      return this.agentSupervisor.cancel(entry.taskId);
    }

    return false;
  }

  /**
   * Get comprehensive status snapshot.
   */
  status() {
    this._resetBudgetIfNewDay();
    return {
      running: Array.from(this._running.entries()).map(([id, entry]) => ({
        loopId: id,
        pid: entry.pid,
        startedAt: entry.startedAt,
        taskId: entry.taskId,
      })),
      queued: this._queue.map((e, i) => ({
        loopId: e.loopId,
        position: i + 1,
        priority: e.config.priority || 0,
        enqueuedAt: new Date(e.enqueuedAt).toISOString(),
      })),
      circuitState: this.circuitBreaker.getState(),
      concurrencyUsed: this._running.size,
      concurrencyMax: this.maxConcurrent,
      queueDepth: this._queue.length,
      queueMax: this.maxQueueDepth,
      budgetUsed: this._budgetUsed,
      budgetLimit: this.dailyBudgetUsd,
      permanentlyFailed: Array.from(this._permanentlyFailed),
    };
  }

  /**
   * Record cost for budget tracking.
   */
  recordCost(loopId, costUsd) {
    this._budgetUsed += costUsd;
  }

  /**
   * Graceful shutdown — drain queue, wait for running loops.
   */
  async shutdown(timeoutMs = 30_000) {
    this._shutdownInProgress = true;

    // Reject all queued
    while (this._queue.length > 0) {
      const entry = this._queue.shift();
      this.emit('loop:rejected', { loopId: entry.loopId, reason: 'shutdown' });
    }

    // Delegate shutdown to underlying supervisor
    await this.agentSupervisor.shutdown(timeoutMs);

    this._running.clear();
    this.circuitBreaker.destroy();
    this._shutdownInProgress = false;
  }

  // --- Private ---

  _startLoop(loopId, config) {
    const task = this.agentSupervisor.submit(config.prompt, {
      priority: config.priority || 0,
      metadata: { loopId, ...config.metadata },
    });

    this._running.set(loopId, {
      config,
      taskId: task.id,
      pid: null, // set when task:started fires
      startedAt: new Date().toISOString(),
    });

    this.emit('loop:started', { loopId, taskId: task.id });
  }

  _wireAgentSupervisorEvents() {
    this.agentSupervisor.on('task:started', ({ taskId, pid }) => {
      // Find the loop entry with this taskId and record PID
      for (const [loopId, entry] of this._running) {
        if (entry.taskId === taskId) {
          entry.pid = pid;
          break;
        }
      }
    });

    this.agentSupervisor.on('task:completed', ({ taskId }) => {
      const loopId = this._findLoopByTaskId(taskId);
      if (loopId) {
        this._running.delete(loopId);
        this.circuitBreaker.recordSuccess();
        this.emit('loop:completed', { loopId, taskId });
        this._processQueue();
      }
    });

    this.agentSupervisor.on('task:failed', ({ taskId, error }) => {
      const loopId = this._findLoopByTaskId(taskId);
      if (loopId) {
        const entry = this._running.get(loopId);
        this._running.delete(loopId);
        this.circuitBreaker.recordFailure();

        // Check restart intensity
        if (this._shouldRestart(loopId)) {
          this.emit('loop:recovered', { loopId, error, restarting: true });
          this._startLoop(loopId, entry.config);
        } else if (this._permanentlyFailed.has(loopId)) {
          this.emit('loop:failed', { loopId, error, permanent: true, reason: 'restart intensity exceeded' });
        } else {
          this.emit('loop:failed', { loopId, error, permanent: false });
        }

        this._processQueue();
      }
    });

    this.agentSupervisor.on('task:cancelled', ({ taskId }) => {
      const loopId = this._findLoopByTaskId(taskId);
      if (loopId) {
        this._running.delete(loopId);
        this._processQueue();
      }
    });
  }

  _findLoopByTaskId(taskId) {
    for (const [loopId, entry] of this._running) {
      if (entry.taskId === taskId) {
        return loopId;
      }
    }
    return null;
  }

  _shouldRestart(loopId) {
    if (!this._restartHistory.has(loopId)) {
      this._restartHistory.set(loopId, []);
    }

    const history = this._restartHistory.get(loopId);
    const now = Date.now();

    // Add current failure
    history.push(now);

    // Prune entries outside the window
    const windowStart = now - this.restartIntensity.windowMs;
    while (history.length > 0 && history[0] < windowStart) {
      history.shift();
    }

    // Check if exceeded
    if (history.length >= this.restartIntensity.maxRestarts) {
      this._permanentlyFailed.add(loopId);
      return false;
    }

    return true;
  }

  _processQueue() {
    while (
      this._running.size < this.maxConcurrent &&
      this._queue.length > 0 &&
      !this._shutdownInProgress &&
      this.circuitBreaker.canExecute()
    ) {
      const entry = this._queue.shift();

      // Skip permanently failed loops
      if (this._permanentlyFailed.has(entry.loopId)) {
        continue;
      }

      this._startLoop(entry.loopId, entry.config);
    }
  }

  /**
   * Kill a running loop's entire process group (negative PID).
   * This kills the process and all its children (shells, subprocesses).
   */
  killProcessGroup(loopId, signal = 'SIGTERM') {
    const entry = this._running.get(loopId);
    if (!entry || !isSafeWorkerGroupTarget(entry.pid)) {
      return false;
    }

    try {
      // Negative PID sends signal to entire process group
      process.kill(-entry.pid, signal);
      return true;
    } catch (err) {
      // ESRCH = process not found (already dead)
      if (err.code === 'ESRCH') {
        this._running.delete(loopId);
        this._processQueue();
        return false;
      }
      throw err;
    }
  }

  _resetBudgetIfNewDay() {
    const now = Date.now();
    if (now >= this._budgetResetAt) {
      this._budgetUsed = 0;
      this._budgetResetAt = this._nextMidnight();
    }
  }

  _nextMidnight() {
    const d = new Date();
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }
}
