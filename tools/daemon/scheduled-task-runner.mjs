/** Scheduled jobs: deterministic owner operations plus explicit legacy agent actions. */

import { EventEmitter } from 'events';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nextCronRun } from './cron-scheduler.mjs';
import { applyChildNiceness, normalizeResources } from './resource-bounds.mjs';
import { importImpl } from '../_resolve-impl.mjs';

const { signalChild } = await importImpl(import.meta.url, 'process/signal-child.mjs');

/**
 * @typedef {'index.verify'|'index.reconcile'|'cache.retention'|'update.check'|'update.install'|'index.freshness'|'index.refresh'|'cache.prune'|'memory.audit'|'memory.recommend'|'memory.apply'} MaintenanceKind
 * @typedef {Object} MaintenanceJob
 * @property {string} id Stable configured job identity
 * @property {MaintenanceKind} kind Closed owner operation; never a prompt
 * @property {string} [cron] Five civil-time cron fields (alias: schedule)
 * @property {string} [timezone] Named IANA timezone, defaults to UTC
 * @property {'skip'|'run-once'} [missedRunPolicy] Downtime coalescing, defaults to skip
 * @property {Object} [args] Owner-specific arguments, never arbitrary CLI tokens
 * @property {number} [timeoutMs] Bounded worker deadline, defaults to 60000
 * @property {0|1|2} [retries] Retries after the first attempt, defaults to 2
 * @property {{baseMs: number, maxMs: number}} [backoff] Equal-jitter bounds
 */
export const MAINTENANCE_KINDS = Object.freeze([
  'index.verify', 'index.reconcile', 'cache.retention', 'update.check',
  'index.freshness', 'index.refresh', 'cache.prune', 'update.install',
  'memory.audit', 'memory.recommend', 'memory.apply',
]);

/** Equal jitter: [ceiling/2, ceiling], capped before jitter; retries never loop in a tick. */
export function retryDelay(attempt, { baseMs = 1000, maxMs = 300000 } = {}, rng = Math.random) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt - 1, 30));
  const sample = rng();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new Error('Invalid retry RNG');
  return Math.floor(ceiling * (0.5 + sample * 0.5));
}

/** Await child exit, including on timeout: an uncertain exit is never safe to replay. */
export function executeMaintenanceOwner(job, { cwd = process.cwd(), onSpawn = () => {}, niceness = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./maintenance-owner.mjs', import.meta.url)), [], {
      cwd, env: { ...process.env, AIWG_MAINTENANCE_WORKER: '1', NO_UPDATE_NOTIFIER: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    if (niceness !== null && niceness !== undefined) applyChildNiceness(child.pid, { niceness });
    let receipt;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; signalChild(child, 'SIGKILL'); }, job.timeoutMs || 60000);
    child.once('message', result => { receipt = result; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (timedOut || signal || !receipt) {
        resolve({ exitStatus: code, state: 'deferred', uncertain: true,
          summary: timedOut ? 'Owner timeout; inspect effects before recovery' : `Owner interrupted (${signal || code}); inspect effects before recovery` });
      } else resolve(receipt);
    });
    try {
      // Record the worker identity before sending it authority to execute.
      onSpawn(child.pid);
      child.send(job);
    } catch (error) {
      signalChild(child, 'SIGKILL');
      clearTimeout(timeout);
      reject(error);
    }
  });
}


/**
 * Built-in action registry — maps action names to task prompts.
 * Users can override these or add custom actions with a `prompt` field
 * in their job config.
 */
const BUILTIN_ACTIONS = {
  doctor: {
    prompt: 'Run `aiwg doctor` and report any issues found. If there are issues, suggest fixes.',
    description: 'Health check',
  },
  'validate-metadata': {
    prompt: 'Run `aiwg validate-metadata` and report any validation errors in extension metadata.',
    description: 'Artifact metadata audit',
  },
  'doc-sync': {
    prompt: 'Run `aiwg doc-sync code-to-docs --dry-run` and report any documentation-code drift found.',
    description: 'Documentation sync check',
  },
  'test-sync': {
    prompt: 'Run `npm test` and report results. If any tests fail, identify the root cause.',
    description: 'Test suite execution',
  },
};

/**
 * @typedef {Object} ScheduledTaskRunnerOptions
 * @property {import('../ralph-external/daemon-supervisor.mjs').DaemonSupervisor} [supervisor]
 * @property {import('./event-router.mjs').default} [eventRouter]
 * @property {import('../messaging/room-manager.mjs').RoomManager} [roomManager]
 * @property {import('./task-store.mjs').TaskStore} [taskStore] Required for maintenance jobs
 * @property {() => number} [now] Epoch milliseconds
 * @property {() => number} [rng] Random sample in [0,1]
 * @property {Function} [executeOwner] Injectable deterministic executor returning an owner receipt
 * @property {string} [cwd] Owner workspace
 * @property {Object} [resources] Validated by resource-bounds.mjs (concurrency, queue, timeout ceiling, niceness)
 */

export class ScheduledTaskRunner extends EventEmitter {
  /** @type {import('../ralph-external/daemon-supervisor.mjs').DaemonSupervisor} */
  #supervisor;

  /** @type {import('./event-router.mjs').default} */
  #eventRouter;

  /** @type {import('../messaging/room-manager.mjs').RoomManager|null} */
  #roomManager;

  /** @type {Map<string, { action: string, lastRun: string|null, runCount: number }>} */
  #jobHistory = new Map();

  /** @type {boolean} */
  #started = false;
  #taskStore;
  #now;
  #rng;
  #executeOwner;
  #cwd;
  #listener;
  #recoveryListener;


  /**
   * @param {ScheduledTaskRunnerOptions} options
   */
  constructor(options) {
    super();
    this.#supervisor = options.supervisor;
    this.#eventRouter = options.eventRouter;
    this.#roomManager = options.roomManager || null;
    this.#taskStore = options.taskStore || null;
    this.#now = options.now || Date.now;
    this.#rng = options.rng || Math.random;
    this.#executeOwner = options.executeOwner || executeMaintenanceOwner;
    this.#cwd = options.cwd || process.cwd();
    const { config, errors } = normalizeResources(options.resources);
    if (errors.length > 0) throw new Error(`Invalid runner resources: ${errors.join('; ')}`);
    this.resources = config;
    this.inflight = 0;
    this.waiters = [];
    this.pendingRuns = 0;
    this.overflowCount = 0;
  }

  /** FIFO slot for the concurrency bound; resolves when a run may execute. */
  acquireSlot() {
    if (this.inflight < this.resources.maxConcurrentJobs) {
      this.inflight++;
      return Promise.resolve();
    }
    return new Promise(resolve => { this.waiters.push(resolve); });
  }

  releaseSlot() {
    const next = this.waiters.shift();
    if (next) next();
    else this.inflight = Math.max(0, this.inflight - 1);
  }

  /**
   * Start listening for cron events.
   */
  start() {
    if (this.#started) return;
    this.#taskStore?.recoverSchedules();
    this.#started = true;

    this.#listener = event => {
      if (!this.#started || event.source !== 'schedule' || event.type !== 'cron.fired') return;
      const handling = event.payload?.kind && event.payload.kind !== 'agent.prompt'
        ? this.runOnce({ ...event.payload, id: event.payload.job_id || event.payload.id }, { fireTime: event.payload.fireTime })
        : this.#handleCronEvent(event);
      handling.catch(error => this.emit('recovery-required', { event, error }));
    };
    this.#eventRouter.on('event', this.#listener);
    this.#recoveryListener = ({ event, error }) => {
      if (event.source === 'watch') {
        this.emit('recovery-required', { event, error });
        return;
      }
      const { job_id: jobId, fireTime, ...job } = event.payload;
      job.id = jobId || job.id;
      if (!this.#taskStore || !job.id) throw error;
      this.#taskStore.ensureSchedule(job);
      this.#taskStore.changeSchedule(job.id, record => {
        record.state = 'blocked';
        record.pendingFireTime ||= fireTime || new Date(this.#now()).toISOString();
        record.lastReceipt = { jobId: job.id, fireTime: record.pendingFireTime, state: 'deferred',
          reason: 'recovery-required', exitStatus: null, summary: error.message,
          startedAt: new Date(this.#now()).toISOString(), finishedAt: new Date(this.#now()).toISOString(),
          durationMs: 0, attemptCount: record.attemptCount, terminal: false };
        record.receipts.push(record.lastReceipt);
        return record;
      });
      this.emit('recovery-required', { event, error });
    };
    this.#eventRouter.on('schedule-recovery-required', this.#recoveryListener);
  }

  stop() {
    this.#started = false;
    if (this.#listener) this.#eventRouter.off('event', this.#listener);
    if (this.#recoveryListener) this.#eventRouter.off('schedule-recovery-required', this.#recoveryListener);
  }

  /** One owner attempt, shared by cron and manual mode. Retried only after persisted retryAt. */
  async runOnce(job, { fireTime } = {}) {
    if (!this.#taskStore) throw new Error('Maintenance requires a persistent TaskStore');
    if (!job.id) throw new Error('Maintenance requires a job ID');
    if (job.kind?.startsWith('memory.')) {
      const { validateMemoryJobArgs } = await importImpl(import.meta.url, 'housekeeper/daemon-config.js');
      validateMemoryJobArgs(job.kind, job.args);
    }
    // Do not persist event envelope fields as configuration.
    const { job_id: _jobId, fireTime: _fireTime, ...configuration } = job;
    job = configuration;
    const now = this.#now();
    const timestamp = new Date(now).toISOString();
    const expression = job.cron || job.schedule;
    const nextRun = expression ? nextCronRun(expression, now, job.timezone).toISOString() : null;
    this.#taskStore.recoverSchedules();
    this.#taskStore.ensureSchedule(job, nextRun);
    const existing = this.#taskStore.getSchedule(job.id);
    fireTime ||= existing.pendingFireTime || new Date(Math.floor(now / 60000) * 60000).toISOString();
    if (!Number.isFinite(Date.parse(fireTime))) throw new Error('Invalid fireTime');
    fireTime = new Date(fireTime).toISOString();
    let claim = false;
    let response;
    this.#taskStore.changeSchedule(job.id, record => {
      const settled = record.receipts.find(receipt => receipt.fireTime === fireTime && receipt.terminal !== false);
      if (settled) {
        response = { ...settled, state: 'skipped', reason: 'already-settled' };
        return record;
      }
      if (record.state === 'running' || record.state === 'blocked') {
        let alive = false;
        if (record.ownerPid) {
          try { process.kill(record.ownerPid, 0); alive = true; }
          catch (error) { if (error.code !== 'ESRCH') alive = true; }
        }
        if (!alive) record.state = 'blocked';
        response = { jobId: job.id, fireTime, state: 'deferred', reason: alive ? 'lock-held' : 'recovery-required',
          exitStatus: null, summary: 'Run outcome unresolved; inspect the retained intent', startedAt: timestamp,
          finishedAt: timestamp, durationMs: 0, attemptCount: record.attemptCount, terminal: false };
        record.lastReceipt = response;
        return record;
      }
      if (record.pendingFireTime && record.pendingFireTime !== fireTime) {
        response = { jobId: job.id, fireTime, state: 'deferred', reason: 'pending-run', summary: 'An earlier run is pending',
          exitStatus: null, startedAt: timestamp, finishedAt: timestamp, durationMs: 0, attemptCount: record.attemptCount, terminal: false };
        return record;
      }
      if (record.retryAt && Date.parse(record.retryAt) > now) {
        response = { ...record.lastReceipt, state: 'deferred', reason: 'backoff' };
        return record;
      }
      claim = true;
      if (record.state === 'idle') record.attemptCount = 0;
      record.state = 'running';
      record.pendingFireTime = fireTime;
      record.attemptCount++;
      record.lastRun = timestamp;
      record.ownerPid = process.pid;
      record.workerPid = null;
      record.nextRun = nextRun;
      record.retryAt = null;
      return record;
    });
    if (!claim) return response;

    this.pendingRuns++;
    try {
      if (this.pendingRuns > this.resources.maxConcurrentJobs + this.resources.maxQueueDepth) {
        return this.overflowRun(job, { fireTime, timestamp, expression });
      }
      return await this.executeClaimed(job, { fireTime, timestamp, expression, supported: MAINTENANCE_KINDS.includes(job.kind) });
    } finally {
      this.pendingRuns--;
    }
  }

  /** Persisted queue-overflow report: the run is dropped, the next fire retries. */
  overflowRun(job, { fireTime, timestamp, expression }) {
    this.overflowCount++;
    const finishedAt = new Date(this.#now()).toISOString();
    let receipt;
    this.#taskStore.changeSchedule(job.id, record => {
      receipt = { jobId: job.id, fireTime, state: 'deferred', reason: 'queue-overflow',
        exitStatus: null,
        summary: `Run queue full (${this.resources.maxConcurrentJobs} concurrent, ${this.resources.maxQueueDepth} queued); run dropped, next fire retries`,
        startedAt: timestamp, finishedAt, durationMs: 0, attemptCount: record.attemptCount, terminal: true };
      record.receipts.push(receipt);
      record.lastReceipt = receipt;
      record.state = 'idle';
      record.ownerPid = null;
      record.workerPid = null;
      record.pendingFireTime = null;
      record.nextRun = expression ? nextCronRun(expression, this.#now(), record.timezone).toISOString() : null;
      return record;
    });
    this.emit('job:overflow', receipt);
    this.emit('job:receipt', receipt);
    return receipt;
  }

  /** Execute a claimed run under the concurrency bound and timeout ceiling. */
  async executeClaimed(job, { fireTime, timestamp, expression, supported }) {
    const now = Date.parse(timestamp);
    let result;
    try {
      if (!supported) result = { exitStatus: 2, summary: `Unsupported task kind: ${job.kind}` };
      else if (job.prompt || job.args?.force || (job.args?.install && job.kind !== 'update.install')) {
        result = { exitStatus: 2, summary: 'Maintenance cannot accept prompts, install, or force authority' };
      } else {
        // Mutation authority stays with each owner (including the exact
        // reviewed memory plan). Clamp deadlines to the global ceiling.
        const boundedJob = { ...job,
          timeoutMs: Math.min(job.timeoutMs || 60000, this.resources.maxTimeoutMs) };
        await this.acquireSlot();
        try {
          result = await this.#executeOwner(boundedJob, { cwd: this.#cwd,
            niceness: this.resources.jobNiceness,
            onSpawn: pid => {
              this.#taskStore.changeSchedule(job.id, record => ({ ...record, workerPid: pid }));
            } });
        } finally {
          this.releaseSlot();
        }
      }
      if (!result || (result.exitStatus !== null && !Number.isInteger(result.exitStatus))) {
        result = { exitStatus: null, uncertain: true, summary: 'Invalid owner receipt; inspect effects' };
      }
      // A mutating memory result must establish a complete, verified success.
      // Even a definite owner refusal requires inspection rather than replay.
      if (job.kind === 'memory.apply' && result.exitStatus !== 0
        && !(result.state === 'deferred' && ['outside-maintenance-window', 'gate-denied'].includes(result.reason))) {
        result = { ...result, uncertain: true };
      }
    } catch (error) {
      // A thrown executor error does not establish whether it launched work.
      result = { exitStatus: null, uncertain: true, summary: error.message };
    }
    const finishedAt = new Date(this.#now()).toISOString();
    let receipt;
    this.#taskStore.changeSchedule(job.id, record => {
      const failed = result.exitStatus !== 0;
      const maxAttempts = Math.min(3, Math.max(1, Number(job.retries ?? 2) + 1));
      const retry = supported && failed && !result.uncertain && result.exitStatus !== 2
        && result.state !== 'deferred' && record.attemptCount < maxAttempts;
      // Owner gate refusals (e.g. update-install policy) carry their own
      // machine-readable reason through to the persisted receipt.
      const gateReason = !result.uncertain && result.state === 'deferred' && typeof result.reason === 'string'
        ? result.reason : undefined;
      receipt = { jobId: job.id, fireTime, state: result.uncertain ? 'deferred' : result.state || (failed ? 'failed' : 'ok'),
        reason: result.uncertain ? 'recovery-required' : retry ? 'retry-pending' : gateReason,
        exitStatus: result.exitStatus, summary: result.summary || '', detail: result.detail,
        startedAt: timestamp, finishedAt, durationMs: Math.max(0, this.#now() - now),
        attemptCount: record.attemptCount, terminal: !retry && !result.uncertain };
      record.receipts.push(receipt);
      record.lastReceipt = receipt;
      record.state = result.uncertain ? 'blocked' : retry ? 'retry' : 'idle';
      record.ownerPid = null;
      if (!result.uncertain) record.workerPid = null;
      record.retryAt = retry ? new Date(this.#now() + retryDelay(record.attemptCount, job.backoff, this.#rng)).toISOString() : null;
      if (!retry && !result.uncertain) record.pendingFireTime = null;
      // Completion advances past downtime too; never queue every slot missed during a slow run.
      record.nextRun = expression ? nextCronRun(expression, this.#now(), record.timezone).toISOString() : null;
      return record;
    });
    this.emit('job:receipt', receipt);
    return receipt;
  }

  /**
   * Handle a cron.fired event by submitting a task.
   *
   * @param {Object} event
   */
  async #handleCronEvent(event) {
    const jobId = event.payload?.job_id || event.payload?.id;
    const action = event.payload?.action;
    const priority = event.payload?.priority ?? 1;

    if (!action) {
      this.emit('recovery-required', { event, error: new Error('Cron event missing action') });
      return;
    }

    const prompt = this.#resolvePrompt(action, event.payload);
    if (!prompt) {
      this.emit('recovery-required', { event, error: new Error(`Unknown action: ${action}`) });
      return;
    }

    console.log(`[scheduled-task-runner] Executing job ${jobId}: ${action}`);

    try {
      const result = await this.#supervisor.submit({
        prompt,
        priority,
        metadata: {
          source: 'scheduler',
          jobId,
          action,
        },
      });

      // Track history
      this.#jobHistory.set(jobId, {
        action,
        lastRun: new Date().toISOString(),
        runCount: (this.#jobHistory.get(jobId)?.runCount || 0) + 1,
      });

      this.emit('job:submitted', { jobId, action, taskId: result?.loopId || result?.taskId });

      // Notify notification-purpose rooms
      if (this.#roomManager) {
        const rooms = this.#roomManager.getBroadcastRooms();
        if (rooms.length > 0) {
          this.emit('notify', {
            message: `Scheduled job "${jobId}" (${action}) submitted`,
            rooms,
          });
        }
      }
    } catch (error) {
      console.error(`[scheduled-task-runner] Failed to submit job ${jobId}: ${error.message}`);
      this.emit('job:failed', { jobId, action, error: error.message });
      this.emit('recovery-required', { event, error });
    }
  }

  /**
   * Resolve action name to a prompt string.
   *
   * @param {string} action
   * @param {Object} payload - Job payload (may contain custom `prompt`)
   * @returns {string|null}
   */
  #resolvePrompt(action, payload) {
    // Custom prompt in job config takes precedence
    if (payload?.prompt) {
      return payload.prompt;
    }

    // Built-in action
    const builtin = BUILTIN_ACTIONS[action];
    if (builtin) {
      return builtin.prompt;
    }

    return null;
  }

  /**
   * Register a custom action.
   *
   * @param {string} name
   * @param {Object} config
   * @param {string} config.prompt
   * @param {string} [config.description]
   */
  registerAction(name, config) {
    BUILTIN_ACTIONS[name] = config;
  }

  /**
   * Get job execution history.
   *
   * @returns {Object[]}
   */
  getHistory() {
    return [...this.#jobHistory.entries()].map(([jobId, info]) => ({
      jobId,
      ...info,
    }));
  }

  /**
   * Get status summary.
   *
   * @returns {Object}
   */
  getStatus() {
    return {
      started: this.#started,
      registeredActions: Object.keys(BUILTIN_ACTIONS),
      maintenanceKinds: [...MAINTENANCE_KINDS],
      schedules: this.#taskStore?.getSchedules() || [],
      jobHistory: this.getHistory(),
      resources: { ...this.resources },
      inflight: this.inflight,
      queued: this.waiters.length,
      overflowed: this.overflowCount,
    };
  }
}

export default ScheduledTaskRunner;

/** Existing daemon schedule surface, no IPC, watcher, supervisor, or background process. */
export async function runManualSchedule(flags, { now = Date.now, executeOwner } = {}) {
  if (process.platform === 'win32') throw new Error('Scheduled maintenance unsupported on Windows; use WSL2');
  const [{ Config }, { TaskStore }] = await Promise.all([import('./config.mjs'), import('./task-store.mjs')]);
  if (typeof flags.job !== 'string') throw new Error('--run-once requires --job ID');
  const config = new Config(flags.config || '.aiwg/daemon.json');
  config.load();
  const job = config.get('schedule.jobs')?.find(job => job.id === flags.job);
  if (!job || !MAINTENANCE_KINDS.includes(job.kind)) throw new Error('Select a configured deterministic maintenance job');
  const store = new TaskStore(flags['store-path'] || '.aiwg/daemon/tasks.json', { now });
  await store.initialize();
  let receipt;
  if (flags.resolve) {
    receipt = store.resolveSchedule(job.id, flags.resolve).lastReceipt;
  } else {
    const runner = new ScheduledTaskRunner({ taskStore: store, now, executeOwner, resources: config.get('resources') });
    receipt = await runner.runOnce(job, { fireTime: flags['fire-time'] });
  }
  console.log(flags.json ? JSON.stringify(receipt) : `${receipt.jobId}: ${receipt.state}: ${receipt.summary}`);
  return receipt.state === 'deferred' ? 3 : receipt.state === 'failed' ? 1 : 0;
}
