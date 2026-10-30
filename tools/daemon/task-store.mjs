/**
 * Task Store - JSON file persistence for agent tasks
 *
 * Tracks all spawned agent tasks with state, results, and history.
 * Provides task queries and summary generation for session reattach.
 *
 * @implements @.aiwg/requirements/use-cases/UC-IPC-002.md
 * @tests @test/unit/daemon/task-store.test.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TASK_STATES = ['queued', 'running', 'completed', 'failed', 'cancelled'];

export class TaskStore {
  constructor(storePath, { now = Date.now } = {}) {
    this.storePath = storePath;
    this.now = now;
    this.schedules = new Map();
    this.persistenceError = null;
    this.hasPersisted = false;
    this.pendingOutputs = new Map();
    this.tasks = new Map();
    this.taskIdCounter = 0;
  }

  /**
   * Initialize store - load existing tasks from disk
   */
  async initialize() {
    const dir = path.dirname(this.storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this._load();
  }

  _load() {
    if (!fs.existsSync(this.storePath)) {
      if (!this.hasPersisted) return;
      this.persistenceError = new Error(`TaskStore recovery required: persisted file disappeared: ${this.storePath}`);
      throw this.persistenceError;
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      if (!data || ![undefined, 1, 2].includes(data.version)
        || (data.tasks !== undefined && !Array.isArray(data.tasks))
        || (data.schedules !== undefined && !Array.isArray(data.schedules))
        || (data.version === 2 && (!Array.isArray(data.tasks) || !Array.isArray(data.schedules)))) {
        throw new Error('Invalid task store schema');
      }
      const tasks = new Map();
      const schedules = new Map();
      for (const task of data.tasks || []) {
        if (typeof task.id !== 'string' || tasks.has(task.id)) throw new Error('Invalid task ID');
        if (this.pendingOutputs.has(task.id)) task.output = (task.output || '') + this.pendingOutputs.get(task.id);
        tasks.set(task.id, task);
        const numPart = parseInt(task.id.split('-').pop(), 10);
        if (!isNaN(numPart)) this.taskIdCounter = Math.max(this.taskIdCounter, numPart + 1);
      }
      for (const record of data.schedules || []) {
        if (!record.job?.id || schedules.has(record.job.id)) throw new Error('Invalid schedule ID');
        const normalized = { timezone: 'UTC', nextRun: null, lastRun: null,
          missedRunPolicy: 'skip', attemptCount: 0, lastReceipt: null, receipts: [],
          state: 'idle', pendingFireTime: null, retryAt: null, ownerPid: null, workerPid: null, ...record };
        if (!['idle', 'pending', 'running', 'retry', 'blocked'].includes(normalized.state)
          || !['skip', 'run-once'].includes(normalized.missedRunPolicy)
          || !Number.isInteger(normalized.attemptCount) || normalized.attemptCount < 0
          || !Array.isArray(normalized.receipts)
          || (normalized.state !== 'idle' && !normalized.pendingFireTime)) throw new Error('Invalid schedule state');
        for (const pid of [normalized.ownerPid, normalized.workerPid]) {
          if (pid !== null && (!Number.isSafeInteger(pid) || pid < 1)) throw new Error('Invalid owner PID');
        }
        for (const receipt of normalized.receipts) {
          if (!receipt || receipt.jobId !== record.job.id || !Number.isFinite(Date.parse(receipt.fireTime))
            || !['ok', 'failed', 'skipped', 'deferred'].includes(receipt.state)) throw new Error('Invalid owner receipt');
        }
        for (const key of ['nextRun', 'lastRun', 'pendingFireTime', 'retryAt']) {
          if (normalized[key] !== null && !Number.isFinite(Date.parse(normalized[key]))) {
            throw new Error(`Invalid schedule ${key}`);
          }
        }
        schedules.set(record.job.id, normalized);
      }
      this.tasks = tasks;
      this.schedules = schedules;
      this.hasPersisted = true;
    } catch (error) {
      this.persistenceError = new Error(`TaskStore recovery required at ${this.storePath}: ${error.message}. Preserve the file; restore a verified backup before retrying.`);
      throw this.persistenceError;
    }
  }

  /** Serialize short store transactions across daemon and manual writers.
   * Never steal an existing lock: even a dead writer may have launched an owner.
   */
  _locked(operation) {
    if (this.persistenceError) throw this.persistenceError;
    const lock = `${this.storePath}.lock`;
    let fd;
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (error) {
      throw new Error(`TaskStore lock-held/recovery-required: ${lock}: ${error.message}`);
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date(this.now()).toISOString() }));
      return operation();
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }

  getSchedule(id) { return structuredClone(this.schedules.get(id) || null); }
  getSchedules() { return structuredClone([...this.schedules.values()]); }

  /** All scheduled state changes reload under the same lock, then rename atomically. */
  changeSchedule(id, change) {
    return this._locked(() => {
      this._load();
      const before = this.getSchedule(id);
      const record = change(structuredClone(before));
      if (record) this.schedules.set(id, record);
      if (JSON.stringify(before) !== JSON.stringify(record)) this._write();
      return this.getSchedule(id);
    });
  }

  ensureSchedule(job, nextRun = null) {
    if (job.retries !== undefined && (!Number.isInteger(job.retries) || job.retries < 0 || job.retries > 2)) {
      throw new Error('retries must be 0, 1, or 2');
    }
    if (job.timeoutMs !== undefined && (!Number.isInteger(job.timeoutMs) || job.timeoutMs < 1 || job.timeoutMs > 3600000)) {
      throw new Error('timeoutMs must be between 1 and 3600000');
    }
    if (job.backoff && (!Number.isFinite(job.backoff.baseMs) || !Number.isFinite(job.backoff.maxMs)
      || job.backoff.baseMs < 1 || job.backoff.maxMs < job.backoff.baseMs || job.backoff.maxMs > 86400000)) {
      throw new Error('backoff requires 1 <= baseMs <= maxMs <= 86400000');
    }
    return this.changeSchedule(job.id, current => {
      const timezone = job.timezone || 'UTC';
      new Intl.DateTimeFormat('en', { timeZone: timezone });
      const missedRunPolicy = job.missedRunPolicy || 'skip';
      if (!['skip', 'run-once'].includes(missedRunPolicy)) throw new Error('Invalid missedRunPolicy');
      if (current) {
        if (JSON.stringify(current.job) !== JSON.stringify(job)) {
          if (current.state !== 'idle') throw new Error(`Schedule ${job.id} has unresolved work; retain its configuration`);
          return { ...current, job, timezone, missedRunPolicy, nextRun };
        }
        if (!current.nextRun && current.state === 'idle' && nextRun) current.nextRun = nextRun;
        return current;
      }
      return { job, timezone, missedRunPolicy, nextRun, lastRun: null,
        state: 'idle', pendingFireTime: null, retryAt: null, attemptCount: 0,
        ownerPid: null, workerPid: null, lastReceipt: null, receipts: [] };
    });
  }

  recoverSchedules() {
    for (const record of this.getSchedules()) {
      if (record.state !== 'running') continue;
      let alive = false;
      if (record.ownerPid) {
        try { process.kill(record.ownerPid, 0); alive = true; }
        catch (error) { if (error.code !== 'ESRCH') alive = true; }
      }
      if (alive) continue;
      this.changeSchedule(record.job.id, current => {
        if (current.state !== 'running' || current.ownerPid !== record.ownerPid) return current;
        const timestamp = new Date(this.now()).toISOString();
        current.state = 'blocked';
        current.lastReceipt = { jobId: current.job.id, fireTime: current.pendingFireTime,
          state: 'deferred', reason: 'recovery-required', exitStatus: null,
          summary: 'Interrupted owner run; inspect effects before acknowledgement',
          startedAt: current.lastRun || timestamp, finishedAt: timestamp,
          durationMs: Math.max(0, this.now() - Date.parse(current.lastRun || timestamp)),
          attemptCount: current.attemptCount, terminal: false };
        current.receipts.push(current.lastReceipt);
        return current;
      });
    }
  }

  /** Explicit operator acknowledgement after inspecting owner effects. No automatic replay. */
  resolveSchedule(id, summary) {
    if (!summary?.trim()) throw new Error('Recovery requires an owner inspection summary');
    return this.changeSchedule(id, record => {
      if (!record || !['running', 'blocked'].includes(record.state)) throw new Error('No interrupted run to resolve');
      for (const pid of [record.ownerPid, record.workerPid]) {
        if (!pid) continue;
        try { process.kill(pid, 0); throw new Error('Owner process may still be alive'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      const finishedAt = new Date(this.now()).toISOString();
      const receipt = { jobId: id, fireTime: record.pendingFireTime, state: 'skipped',
        reason: 'operator-resolved', exitStatus: null, summary,
        startedAt: record.lastRun || finishedAt, finishedAt,
        durationMs: Math.max(0, this.now() - Date.parse(record.lastRun || finishedAt)),
        attemptCount: record.attemptCount };
      record.receipts.push(receipt);
      return { ...record, state: 'idle', pendingFireTime: null, retryAt: null,
        ownerPid: null, workerPid: null, lastReceipt: receipt };
    });
  }

  /**
   * Create a new task
   */
  createTask(options) {
    const id = `task-${String(this.taskIdCounter++).padStart(4, '0')}`;
    const task = {
      id,
      prompt: options.prompt,
      agent: options.agent || null,
      priority: options.priority || 0,
      state: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      pid: null,
      result: null,
      error: null,
      output: '',
      metadata: options.metadata || {},
    };

    this.tasks.set(id, task);
    this._persist();
    return task;
  }

  /**
   * Update task state
   */
  updateTask(id, updates) {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    // Validate state transitions
    if (updates.state) {
      if (!TASK_STATES.includes(updates.state)) {
        throw new Error(`Invalid state: ${updates.state}`);
      }
    }

    Object.assign(task, updates);
    this._persist();
    return task;
  }

  /**
   * Mark task as running
   */
  startTask(id, pid) {
    return this.updateTask(id, {
      state: 'running',
      startedAt: new Date().toISOString(),
      pid,
    });
  }

  /**
   * Mark task as completed
   */
  completeTask(id, result) {
    return this.updateTask(id, {
      state: 'completed',
      completedAt: new Date().toISOString(),
      result,
      pid: null,
    });
  }

  /**
   * Mark task as failed
   */
  failTask(id, error) {
    return this.updateTask(id, {
      state: 'failed',
      completedAt: new Date().toISOString(),
      error: typeof error === 'string' ? error : error.message,
      pid: null,
    });
  }

  /**
   * Mark task as cancelled
   */
  cancelTask(id) {
    return this.updateTask(id, {
      state: 'cancelled',
      completedAt: new Date().toISOString(),
      pid: null,
    });
  }

  /**
   * Append output to a task
   */
  appendOutput(id, chunk) {
    const task = this.tasks.get(id);
    if (task) {
      task.output += chunk;
      this.pendingOutputs.set(id, (this.pendingOutputs.get(id) || '') + chunk);
      // Don't persist on every chunk - too expensive
    }
  }

  /**
   * Get a task by ID
   */
  getTask(id) {
    return this.tasks.get(id) || null;
  }

  /**
   * Get all tasks, optionally filtered by state
   */
  getTasks(filter = {}) {
    let result = Array.from(this.tasks.values());

    if (filter.state) {
      result = result.filter(t => t.state === filter.state);
    }

    if (filter.agent) {
      result = result.filter(t => t.agent === filter.agent);
    }

    // Sort by creation time, newest first
    result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (filter.limit) {
      result = result.slice(0, filter.limit);
    }

    return result;
  }

  /**
   * Get summary statistics
   */
  getStats() {
    const tasks = Array.from(this.tasks.values());
    return {
      total: tasks.length,
      queued: tasks.filter(t => t.state === 'queued').length,
      running: tasks.filter(t => t.state === 'running').length,
      completed: tasks.filter(t => t.state === 'completed').length,
      failed: tasks.filter(t => t.state === 'failed').length,
      cancelled: tasks.filter(t => t.state === 'cancelled').length,
    };
  }

  /**
   * Generate a summary for session reattach
   */
  getSummary() {
    const stats = this.getStats();
    const running = this.getTasks({ state: 'running' });
    const recent = this.getTasks({ limit: 5 });

    return {
      stats,
      running: running.map(t => ({
        id: t.id,
        prompt: t.prompt.slice(0, 80),
        agent: t.agent,
        startedAt: t.startedAt,
      })),
      recent: recent.map(t => ({
        id: t.id,
        prompt: t.prompt.slice(0, 80),
        state: t.state,
        completedAt: t.completedAt,
      })),
    };
  }

  /**
   * Clean up old completed/failed tasks
   */
  cleanup(maxAge = 7 * 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAge;
    let removed = 0;

    for (const [id, task] of this.tasks) {
      if (
        (task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled') &&
        task.completedAt &&
        new Date(task.completedAt).getTime() < cutoff
      ) {
        this.tasks.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      this._persist();
    }

    return removed;
  }

  /**
   * Get count of tasks
   */
  get size() {
    return this.tasks.size;
  }

  // --- Private methods ---

  _persist() {
    return this._locked(() => {
      // Agent-task writes must retain receipts written by a manual process.
      const tasks = this.tasks;
      this._load();
      this.tasks = tasks;
      this._write();
    });
  }

  _write() {
    const data = { version: 2, updatedAt: new Date(this.now()).toISOString(),
      tasks: [...this.tasks.values()], schedules: [...this.schedules.values()] };
    const temporary = `${this.storePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
      const fd = fs.openSync(temporary, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.storePath);
      const directory = fs.openSync(path.dirname(this.storePath), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      this.hasPersisted = true;
      this.pendingOutputs.clear();
    } catch (error) {
      this.persistenceError = new Error(`TaskStore: Failed to persist; recovery required: ${error.message}`);
      throw this.persistenceError;
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}
