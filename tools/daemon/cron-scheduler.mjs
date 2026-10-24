import { EventEmitter } from 'node:events';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const formatters = new Map();

function wallTime(ms, timezone) {
  if (timezone === 'UTC') {
    const date = new Date(ms);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes());
  }
  if (!formatters.has(timezone)) formatters.set(timezone, new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }));
  const parts = Object.fromEntries(formatters.get(timezone).formatToParts(ms).map(p => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
}

function fieldValues(field, min, max) {
  const values = new Set();
  for (const entry of field.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(entry);
    if (!match) throw new Error(`Invalid cron field: ${field}`);
    const step = Number(match[2] || 1);
    const range = match[1] === '*' ? [min, max] : match[1].split('-').map(Number);
    const start = range[0];
    const end = range[1] ?? (match[2] ? max : start);
    if (step < 1 || step > max - min + 1 || start < min || end > max || start > end) throw new Error(`Invalid cron field: ${field}`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function parseCron(expression) {
  const fields = expression?.trim().split(/\s+/);
  if (fields?.length !== 5) throw new Error('Cron requires five fields');
  return fields.map((field, i) => fieldValues(field, [0, 0, 1, 1, 0][i], [59, 23, 31, 12, 6][i]));
}

/** Named-zone civil cron: choose the first fold occurrence; shift gaps forward.
 * Search civil days, not missed UTC slots, so years of downtime cost one next-run lookup.
 * Day-of-month AND day-of-week preserves the daemon's existing convention.
 */
export function nextCronRun(expression, after, timezone = 'UTC') {
  const fields = parseCron(expression);
  const afterMs = +new Date(after);
  if (!Number.isFinite(afterMs)) throw new Error('Invalid cron clock');
  const local = new Date(wallTime(afterMs, timezone));
  const firstDay = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  for (let day = firstDay; day < firstDay + 8 * 366 * DAY; day += DAY) {
    const date = new Date(day);
    if (!fields[2].has(date.getUTCDate()) || !fields[3].has(date.getUTCMonth() + 1) || !fields[4].has(date.getUTCDay())) continue;
    const offsets = new Set(timezone === 'UTC' ? [0] : [-36, -12, 12, 36].map(hours => {
      const ms = day + hours * 60 * MINUTE;
      return wallTime(ms, timezone) - ms;
    }));
    let next = Infinity;
    for (const hour of fields[1]) for (const minute of fields[0]) {
      const target = day + (hour * 60 + minute) * MINUTE;
      const candidates = [...offsets].map(offset => target - offset);
      const exact = candidates.filter(ms => wallTime(ms, timezone) === target);
      // Missing time: compatible shift by the transition gap (02:30 -> 03:30).
      const shifted = candidates.filter(ms => wallTime(ms, timezone) > target)
        .sort((a, b) => wallTime(a, timezone) - wallTime(b, timezone));
      const instant = exact.length ? Math.min(...exact) : shifted[0];
      if (instant > afterMs) next = Math.min(next, instant);
    }
    if (Number.isFinite(next)) return new Date(next);
  }
  throw new Error(`Cron has no occurrence within eight years: ${expression}`);
}

export class CronScheduler extends EventEmitter {
  constructor(config, { taskStore = null, now = Date.now } = {}) {
    super();
    this.config = config;
    this.taskStore = taskStore;
    this.now = now;
    this.intervals = new Map();
    this.lastFires = new Map();
  }

  start() {
    if (!this.config.enabled) return;
    for (const job of this.config.jobs) this.scheduleJob(job);
  }

  scheduleJob(job) {
    if (this.intervals.has(job.id)) return;
    const expression = job.cron || job.schedule;
    parseCron(expression);
    if (job.kind && job.kind !== 'agent.prompt') {
      if (!this.taskStore) throw new Error('Typed schedules require a TaskStore');
      this.taskStore.ensureSchedule(job, nextCronRun(expression, this.now(), job.timezone).toISOString());
      this.tick(job);
    }
    const interval = setInterval(() => {
      try { this.tick(job); }
      catch (error) {
        // Stop only this trigger. Persisted intent is retained; never continue blind.
        clearInterval(this.intervals.get(job.id));
        this.intervals.delete(job.id);
        this.emit('recovery-required', { jobId: job.id, error });
      }
    }, job.kind && job.kind !== 'agent.prompt' ? 1000 : MINUTE);
    this.intervals.set(job.id, interval);
  }

  /** Public tick for deterministic tests and a single bounded downtime reconciliation. */
  tick(job) {
    const now = this.now();
    if (!job.kind || job.kind === 'agent.prompt') {
      const date = new Date(now);
      if (!this.cronMatches(job.cron, date, job.timezone)) return;
      const minute = Math.floor(now / MINUTE);
      if (Math.floor(+(this.lastFires.get(job.id) || 0) / MINUTE) === minute) return;
      this.lastFires.set(job.id, date);
      this.emit('event', { source: 'schedule', type: 'cron.fired',
        payload: { job_id: job.id, action: job.action, ...(job.prompt ? { prompt: job.prompt } : {}) } });
      return;
    }
    let fireTime = null;
    const record = this.taskStore.changeSchedule(job.id, record => {
      if (!record) throw new Error(`Schedule missing: ${job.id}`);
      if (record.state === 'blocked' || record.state === 'running') return record;
      if (record.state === 'retry' || record.state === 'pending') {
        if (!record.retryAt || Date.parse(record.retryAt) <= now) fireTime = record.pendingFireTime;
        return record;
      }
      if (Date.parse(record.nextRun) > now) return record;
      const missed = Date.parse(record.nextRun) < Math.floor(now / MINUTE) * MINUTE;
      const due = record.nextRun;
      record.nextRun = nextCronRun(job.cron || job.schedule, now, record.timezone).toISOString();
      if (missed && record.missedRunPolicy === 'skip') {
        const timestamp = new Date(now).toISOString();
        record.lastReceipt = { jobId: job.id, fireTime: due, state: 'skipped',
          reason: 'missed-run', summary: 'Missed slots coalesced and skipped', exitStatus: null,
          startedAt: timestamp, finishedAt: timestamp, durationMs: 0, attemptCount: 0 };
        record.receipts.push(record.lastReceipt);
      } else {
        record.state = 'pending';
        record.pendingFireTime = due;
        record.attemptCount = 0;
        fireTime = due;
      }
      return record;
    });
    if (fireTime) {
      this.lastFires.set(job.id, new Date(fireTime));
      this.emit('event', { source: 'schedule', type: 'cron.fired',
        payload: { ...record.job, job_id: job.id, fireTime } });
    }
  }

  cronMatches(expression, date, timezone = 'UTC') {
    const fields = parseCron(expression);
    const local = new Date(wallTime(+date, timezone));
    return [local.getUTCMinutes(), local.getUTCHours(), local.getUTCDate(), local.getUTCMonth() + 1, local.getUTCDay()]
      .every((value, i) => fields[i].has(value));
  }

  matchesField(field, value, min, max) { return fieldValues(field, min, max).has(value); }

  stop() {
    for (const interval of this.intervals.values()) clearInterval(interval);
    this.intervals.clear();
  }

  getStats() {
    return { enabled: this.config.enabled, jobs: this.config.jobs.length,
      last_fires: Object.fromEntries([...this.lastFires].map(([id, date]) => [id, date.toISOString()])) };
  }
}

export default CronScheduler;
