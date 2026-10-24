# AIWG Daemon Mode

Implementation of background daemon for AIWG following ADR-daemon-mode.

## Architecture

The daemon implements a Unix-style PID-file based lifecycle with event-driven architecture:

```
CLI (index.mjs)
  ├─ start: Spawns daemon-main.mjs detached
  ├─ stop: Sends SIGTERM to PID
  ├─ status: Reads state.json
  └─ logs: Tails daemon.log

Daemon (daemon-main.mjs)
  ├─ Lifecycle Manager (PID, signals, heartbeat)
  ├─ Event Sources
  │   ├─ FileWatcher (fs.watch with debounce)
  │   └─ CronScheduler (setInterval with cron matching)
  └─ Event Router (pub/sub event bus)
```

## Files

| File | Purpose |
|------|---------|
| `index.mjs` | CLI entry point (start/stop/status/logs) |
| `daemon-main.mjs` | Main daemon process and subsystem orchestration |
| `config.mjs` | Configuration loader and validator |
| `file-watcher.mjs` | File system change detection |
| `cron-scheduler.mjs` | Periodic task scheduling |
| `event-router.mjs` | Event pub/sub with dead letter queue |
| `ipc-server.mjs` | JSON-RPC 2.0 server over Unix domain socket |
| `ipc-client.mjs` | IPC client for CLI↔daemon communication |
| `agent-supervisor.mjs` | Spawns and tracks `claude -p` subprocesses with concurrency limits |
| `task-store.mjs` | Persistent task queue with state tracking |
| `automation-engine.mjs` | Trigger→condition→action rule engine |
| `tmux-manager.mjs` | Tmux session management for interactive agent sessions |
| `repl-chat.mjs` | Interactive terminal chat with AI via daemon |

## Usage

### Start Daemon

```bash
# Start in background (normal mode)
node tools/daemon/index.mjs start

# Start in foreground (Docker/systemd)
node tools/daemon/index.mjs start --foreground
```

### Stop Daemon

```bash
node tools/daemon/index.mjs stop
```

### Check Status

```bash
node tools/daemon/index.mjs status
```

### View Logs

```bash
# Show last 50 lines
node tools/daemon/index.mjs logs

# Show last 100 lines
node tools/daemon/index.mjs logs --lines 100

# Follow logs in real-time
node tools/daemon/index.mjs logs --follow
```

### Restart Daemon

```bash
node tools/daemon/index.mjs restart
```

## Configuration

Configuration stored in `.aiwg/daemon.json`. Default configuration created on first start.

### Default Configuration

```json
{
  "daemon": {
    "heartbeat_interval_seconds": 30,
    "max_parallel_actions": 3,
    "action_timeout_minutes": 120,
    "log": {
      "max_size_mb": 50,
      "max_files": 5,
      "level": "info"
    }
  },
  "watch": {
    "enabled": true,
    "paths": [
      {
        "path": ".aiwg/",
        "events": ["create", "modify", "delete"],
        "ignore": ["*.tmp", "working/**", "daemon/**"]
      },
      {
        "path": "src/",
        "events": ["modify"],
        "extensions": [".ts", ".js", ".mjs"]
      }
    ],
    "debounce_ms": 2000
  },
  "schedule": {
    "enabled": true,
    "jobs": [
      {
        "id": "health-check",
        "cron": "0 */6 * * *",
        "action": "doctor"
      }
    ]
  }
}
```

## File System Layout

```
.aiwg/
  daemon.pid                  # PID file (only when running)
  daemon.json                 # Configuration
  daemon/
    state.json                # Daemon state
    daemon.log                # Current log
    daemon.log.1              # Rotated log
    heartbeat                 # Liveness indicator
    actions/                  # Action outputs
    events/                   # Event history
    .lock                     # Advisory lock file
```

## Lifecycle

### Startup

1. Check for existing daemon (validate PID file)
2. Create directories (`.aiwg/daemon/`, etc.)
3. Acquire advisory lock (`.aiwg/daemon/.lock`)
4. Spawn detached process (or run in foreground)
5. Write PID file (`.aiwg/daemon.pid`)
6. Install signal handlers (SIGTERM, SIGINT, SIGHUP)
7. Load configuration
8. Initialize subsystems (FileWatcher, CronScheduler)
9. Start heartbeat writer
10. Begin event processing

### Shutdown

1. Receive SIGTERM/SIGINT
2. Set shutdown flag (reject new events)
3. Stop event sources (close watchers, clear intervals)
4. Write final state
5. Remove PID file
6. Release lock file
7. Exit gracefully

### Config Reload

Send SIGHUP to reload configuration:

```bash
kill -HUP $(cat .aiwg/daemon.pid)
```

## Docker Usage

Use `--foreground` flag to run as PID 1 in containers:

```dockerfile
FROM node:24-alpine
WORKDIR /app
COPY . .
CMD ["node", "tools/daemon/index.mjs", "start", "--foreground"]
```

## Features

### File Watching

- Uses `fs.watch` with recursive support
- Debounce mechanism (500ms default)
- Configurable paths and file extensions
- Automatic ignore patterns (node_modules, .git, working/, daemon/)

### Cron Scheduling

- Standard 5-field cron expressions
- Minute-level granularity
- Supports wildcards, ranges, steps, lists
- Example: `0 */6 * * *` = every 6 hours

### Event Routing

- Pub/sub event bus
- Dead letter queue for failed handlers
- Max 3 retries with exponential backoff
- Event history (last 1000 events)

### Log Rotation

- Size-based rotation (50MB default)
- Keep N rotated files (5 default)
- Automatic cleanup of old logs

### Health Monitoring

- Heartbeat file updated every 30s
- State file with uptime, monitors, actions
- PID validation on status check

## Token Security

Configuration never contains secrets. All sensitive values referenced via environment variables:

```json
{
  "webhook": {
    "secret_env": "AIWG_WEBHOOK_SECRET"
  }
}
```

Secrets loaded from `process.env` at runtime.

## Implementation Notes

### Advisory Locking

Uses `fs.openSync(lockFile, 'wx')` for atomic lock acquisition. Prevents multiple daemon instances.

### PID File Management

Atomic write pattern:
```javascript
fs.writeFileSync(`${pidFile}.tmp`, String(pid));
fs.renameSync(`${pidFile}.tmp`, pidFile);
```

### Detached Process

```javascript
const child = spawn(process.execPath, [daemonScript], {
  detached: true,
  stdio: ['ignore', logFd, logFd],
  env: process.env
});
child.unref();
```

### Signal Handling

Graceful shutdown preserves state:
```javascript
process.on('SIGTERM', () => {
  shutdownInProgress = true;
  stopSubsystems();
  writeState();
  cleanup();
  process.exit(0);
});
```

## Testing

Test daemon lifecycle:

```bash
# Start daemon
node tools/daemon/index.mjs start

# Verify running
node tools/daemon/index.mjs status

# Watch logs
node tools/daemon/index.mjs logs --follow &

# Stop daemon
node tools/daemon/index.mjs stop
```

## Troubleshooting

### Daemon won't start

Check for stale PID file:
```bash
cat .aiwg/daemon.pid
ps -p $(cat .aiwg/daemon.pid)
```

If process is dead, remove PID file:
```bash
rm .aiwg/daemon.pid
```

### Daemon won't stop

Force kill:
```bash
kill -9 $(cat .aiwg/daemon.pid)
rm .aiwg/daemon.pid
```

### Check logs

```bash
tail -f .aiwg/daemon/daemon.log
```

### Verify state

```bash
cat .aiwg/daemon/state.json | jq .
```

## Subsystem Architecture

The daemon orchestrates several subsystems initialized in this order:

```
EventRouter → TaskStore → AgentSupervisor → AutomationEngine
→ IPCServer → FileWatcher → CronScheduler → MessagingHub
```

### IPC Server (`ipc-server.mjs`)

JSON-RPC 2.0 protocol over Unix domain socket (`.aiwg/daemon/daemon.sock`). Supports methods: `daemon.status`, `task.submit`, `task.cancel`, `task.list`, `task.get`, `task.stats`, `automation.status`, `automation.enable`, `automation.disable`, `chat.send`, `ping`.

### Agent Supervisor (`agent-supervisor.mjs`)

Manages a pool of `claude -p` subprocesses with configurable concurrency (default: 3). Emits events: `task:started`, `task:completed`, `task:failed`, `task:timeout`. Tasks are persisted in the Task Store.

### Task Store (`task-store.mjs`)

Persistent JSON-based task queue at `.aiwg/daemon/tasks.json`. Tracks task state (queued, running, completed, failed), priority, timestamps, and output.

### Automation Engine (`automation-engine.mjs`)

Event-driven rule system. Rules define trigger→condition→action workflows loaded from `.aiwg/daemon.json`. Supports event matching, shell-based conditions, and agent task actions.

### Messaging Integration

The daemon dynamically imports `tools/messaging/index.mjs` to connect Slack, Discord, and Telegram. See [Messaging Guide](../../docs/messaging-guide.md).

## References

- ADR: `.aiwg/architecture/adrs/ADR-daemon-mode.md`
- ADR: `.aiwg/architecture/adrs/ADR-ipc-protocol.md`
- ADR: `.aiwg/architecture/adrs/ADR-2way-chat.md`
- User Guide: `docs/daemon-guide.md`
- Issues: #312, #315, #316, #317, #318
- Ralph External: `tools/ralph-external/` (background process pattern)

## Deterministic scheduled maintenance (#3353 B2)

The existing CronScheduler and ScheduledTaskRunner also accept typed jobs. These
jobs invoke owner APIs in a bounded Node worker; they never submit prompts or
construct a model supervisor. No dependencies or second scheduler are added.
Existing `action` jobs retain their agent submission behavior; `kind: agent.prompt`
explicitly selects that same opt-in behavior. Maintenance jobs cannot carry prompts,
install flags, or force cleanup authority.

| `kind` | Deterministic owner entry point | Meaning |
| --- | --- | --- |
| `index.verify` (`index.freshness`) | `src/artifacts/index-status.ts:collectIndexStatus(cwd)` (`aiwg index status`) | Read the registered graph status, missing indices and warnings. This is a status probe, not a checksum audit or B4 convergence claim. |
| `index.reconcile` (`index.refresh`) | `src/artifacts/index-refresh.ts:runIndexRefresh(args, cwd)` (`aiwg index refresh`) | Existing incremental reconciliation; `args.index` maps to the owner's `--only`, with optional `workspace`, `root`, `dryRun`. |
| `cache.retention` (`cache.prune`) | `src/resources/cache-cleanup.ts:cleanWebResourceCache(cwd, options)` (`aiwg versions clean-cache`) | Prune unreferenced release generations, preserving lockfile-protected items. Optional `cacheRoot` and `dryRun`; never `force`. Retention follows this owner's policy. |
| `update.check` | `src/update/checker.mjs:checkUpdateStatus({channel})` | Check stable/next/nightly registry versions. No prompt, install, config save, or redeploy. Edge returns `deferred/unsupported`; the old forced checker can install on edge and is deliberately excluded. |

Example job in the existing `schedule.jobs` array:

```json
{
  "id": "reconcile-sessions",
  "kind": "index.reconcile",
  "cron": "15 * * * *",
  "timezone": "America/New_York",
  "missedRunPolicy": "run-once",
  "timeoutMs": 60000,
  "retries": 2,
  "backoff": { "baseMs": 1000, "maxMs": 300000 },
  "args": { "index": "sessions" }
}
```

`cron` also accepts the B1 name `schedule`. Timezone defaults to UTC. Cron has
five fields (wildcards, lists, ranges, steps; weekday 0=Sunday), with the existing
AND convention for day-of-month and weekday. Invalid expressions fail closed.
Cron works in civil time using IANA zones: a nonexistent time shifts forward by
the gap (New York 2026-03-08 02:30 becomes 03:30); a repeated time fires only at
its first occurrence (2026-11-01 01:30 EDT, never again at 01:30 EST). Next-run
calculation after a restart inside the fold uses the same rule. Overlapping gap
and ordinary occurrences at the same instant coalesce. UTC schedules have no DST.

### Persisted state and retries

`tasks.json` version 2 preserves the version 1 `tasks` array and adds `schedules`.
Version 1 files load without rewriting until a mutation. Missing schedule fields
default to `timezone: UTC`, `missedRunPolicy: skip`, `state: idle`,
`attemptCount: 0`, empty `receipts`, and null `nextRun`, `lastRun`, `lastReceipt`,
`pendingFireTime`, `retryAt`, `ownerPid`, and `workerPid`. Registration computes
an absent next-run value. Existing agent task fields and IDs stay intact.

Each schedule stores its complete `job`, civil timezone, next scheduled UTC
instant, last owner start, policy, state (`idle|pending|running|retry|blocked`),
attempt count for the current fire identity, pending fire time, retry deadline,
parent/worker PIDs, last receipt, and attempt receipts. Receipts include job ID,
fire time, `ok|failed|skipped|deferred`, exit status (null if unknown/not run),
summary, owner detail, start/finish timestamps, duration, attempt count, and
whether the receipt settles that fire identity. Receipts remain retained for
deduplication; bounded retention needs a retained deduplication watermark before
it can safely prune them.

Startup and each tick reconcile at most one pending identity per job. `skip`
records one skipped receipt for the missed interval; `run-once` executes one
coalesced run identified by the oldest retained due time. Both advance nextRun
past the current time without enumerating missed slots. Completion also advances
past time spent running. New typed jobs start at their next future slot. A
pending/retrying job never accumulates a second queue of missed runs.

Known owner failures retry the same identity up to `retries + 1` attempts
(default 3, maximum 3). Equal jitter chooses a delay in `[ceiling/2, ceiling]`,
where `ceiling = min(maxMs, baseMs * 2^(attemptCount-1))`. Deadline, attempts, and
receipts persist before another attempt; one tick can dispatch only one attempt.
Downtime during backoff yields one attempt after restart, with no retry burst.
Typed schedules poll once per second, so a due deadline can run up to a tick
later. Clock and RNG are injectable. Invalid kinds/authority fail terminally;
owner deferrals do not retry. An uncertain owner result blocks for review.

### One scheduled-work recovery policy: retain, block, inspect, acknowledge

The store is the authority for maintenance intent, attempts, and receipts.
Transient router history/DLQ is never the recovery authority for typed jobs.

1. Persist intent and claim under an exclusive short store transaction **before**
   giving a worker execution authority. Record the worker PID before sending it
   the job. Daemon and manual callers use the same transactions and fire-time
   deduplication. Atomic temp-file writes, file/directory fsync, and rename keep
   readers from observing partial JSON. A failed write stops execution.
2. Known owner exit results receive receipts. A thrown executor error, killed or
   timed-out worker, missing receipt, or interrupted persisted `running` state
   has an uncertain outcome: retain the identity and block it. There is no
   automatic replay of uncertain work. A live run returns `deferred/lock-held`.
3. Corrupt/unreadable/unsupported store data or a disappearing persisted file
   stops use of that store and preserves the source. Restore a verified backup
   and inspect any affected owner effects; never start from an empty file.
4. Existing store transaction locks (including stale locks) remain in place and
   produce `lock-held/recovery-required`. Stop all writers, inspect the lock's
   PID and any owner worker, preserve a copy of the lock/store, and remove only
   the verified abandoned lock. Restart still blocks unresolved run intent.
   The daemon's existing lifecycle lock follows the same stop-and-inspect rule;
   this slice does not steal it or change lifecycle locking.
5. After checking owner effects and verifying parent/worker processes are gone,
   explicitly acknowledge the blocked job with `--resolve "inspection summary"`
   (below). This records `skipped/operator-resolved` for that fire identity and
   re-enables future scheduled slots. It does **not** replay the uncertain run.
   If work remains necessary, invoke the next fire minute explicitly. A replay
   of the resolved identity remains deduplicated.

The runner emits `recovery-required` for diagnostics. Typed failures explicitly
sent to `EventRouter.handleFailedEvent` go straight to a persisted blocked
receipt through the runner; they bypass the router's independent retry timer.
The router edit changes only this failure handoff, not `route()` or watcher
routing. Other event sources and legacy agent actions retain their existing
behavior for B3. Unresolved pending jobs remain in the store even if delivery is
interrupted before a handler starts.

### Manual execution with the daemon disabled

Use the existing daemon CLI script and its `schedule` command. In a source
checkout, run `npm run build:cli` first to materialize the owner modules;
installed packages already include them:

```bash
node tools/daemon/index.mjs schedule --run-once --job reconcile-sessions --json
node tools/daemon/index.mjs schedule --run-once --job reconcile-sessions \
  --fire-time 2026-10-24T12:15:00Z --json
node tools/daemon/index.mjs schedule --run-once --job reconcile-sessions \
  --resolve "Verified owner effects and no live worker" --json
```

`--config PATH` and `--store-path PATH` support isolated runs. Manual mode reads
the job even when `schedule.enabled` is false. It loads no watcher, timers, IPC
server or model supervisor, and creates no scratch directories. The owner uses
its existing workspace/cache/temp rules. `--json` stdout is exactly one receipt;
owner stdout is isolated from it. Exit 0 means success/already settled, 1 owner
failure, 3 deferral. Invocation/store errors produce a diagnostic and nonzero
exit. This script is the existing CLI surface; no new `housekeeper` command
family is introduced by B2. Linux/macOS are supported; Windows should use WSL2.
Native timers can invoke this same manual command as the D2 alternative.

Per-index targets, adapter registration, convergence, watch reconciliation,
resource/maintenance-window gates, minimal daemon profiles, and broader status
surfaces remain follow-on integration work. This slice records owner reports;
it never derives a freshness or convergence claim from a configured target.
