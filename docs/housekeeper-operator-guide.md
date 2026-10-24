# Housekeeper operator guide (epic #3353, slice B6)

The housekeeper is the deterministic maintenance profile of the AIWG daemon:
cron-scheduled owner operations with persisted receipts, optional file-watch
hints, and a minimal IPC surface. It never runs prompts, agents, memory
writes, or model calls. Design boundary:
`docs/architecture/housekeeper-daemon-boundary.md`.

## Setup

```bash
# Seed the housekeeper profile config (.aiwg/daemon.yaml)
aiwg housekeeper start --foreground   # foreground, or without the flag to detach
aiwg housekeeper status               # daemon, job, and freshness state
aiwg housekeeper run-once --job <id>  # one job, no daemon required
aiwg housekeeper stop
```

Register check-only jobs with `aiwg housekeeper job register --id <id>
--kind <kind> --schedule "<cron>" [--timezone <IANA>]`. Known kinds:
`index.verify`, `index.reconcile`, `cache.retention`, `update.check`,
`update.install` (opt-in, see below), `index.freshness`, `index.refresh`,
`cache.prune`.

## Exclusions (not scheduled here)

- **Memory-maintenance jobs are out of scope.** Their owner contracts
  (#3282–#3284) are not delivered, so this slice adds no memory job kinds.
- Scheduled jobs never redeploy providers or frameworks. `update.install`
  performs the package step only; re-deploy separately with
  `aiwg update --skip-check` when ready.
- The housekeeper profile never constructs the conversational stack (agents,
  behaviors, messaging, web server); those IPC methods are not registered.

## Update policy

`update.check` is check-only: it probes the registry for `stable` (and
`next`/`nightly`) and reports `available: true/false`. It never installs.
The `edge` channel has no read-only probe and reports `unsupported`.

`update.install` is a separate, explicit opt-in. Add it by editing the job
entry in `.aiwg/daemon.yaml` (there is no CLI flag for install authority,
so it cannot be enabled by accident):

```yaml
schedule:
  jobs:
    - id: weekly-update
      kind: update.install
      cron: '30 3 * * 0'
      timezone: America/New_York
      args:
        install: true            # required; absent/false refuses (check-only default)
        channel: stable           # stable | edge (edge has no probe: always defers)
        versionPolicy: patch      # patch | minor | any; default patch
        allowMajor: false         # majors never install unless this is true
        windows:                  # optional; absent means any time
          - { start: '02:00', end: '04:00', days: [0, 6], timezone: America/New_York }
```

Gates, evaluated in order; any failure records a `deferred` receipt with the
named reason and never installs:

| Gate | Deferred reason |
|---|---|
| Per-job opt-in (`args.install === true`) | `install-not-enabled` |
| Policy shape (channel, versionPolicy, window ranges) | `invalid-policy` |
| Inside a maintenance window (named-zone ranges, DST-aware like cron) | `outside-maintenance-window` |
| Registry probe succeeds; update actually available | `unsupported-channel` |
| Bump within `versionPolicy`; major only with `allowMajor: true` | `version-policy` / `major-not-allowed` |
| No active AIWG work (see "What blocks an install" below) | `active-work` (names each) |
| Installer preflight passes (the installer's own dry-run checks) | `preflight-failed` / `install-manual-required` (source checkouts stay manual) |

An installer that throws mid-flight has unknown effects: the outcome is
`uncertain` and goes to the existing `schedule-recovery-required` path
(`blocked` schedule, explicit `run-once --resolve` acknowledgement). It is
never auto-retried.

## What blocks an install

The `active-work` gate defers when ANY of these hold (each is named in the
receipt). A detector that cannot read its store fails closed: the install
defers with a `work-detection-unavailable:<reason>` entry instead of
assuming nothing is running. Only a cleanly absent store means "no work".

- Daemon schedules in `running`, `blocked`, `retry`, or `pending` state
  (`daemon-task:<job-id>`), and agent tasks in `running` or `queued` state
  (`agent-task:<id>`) — from `.aiwg/daemon/tasks.json`. A missing file
  means no daemon work; an unreadable or corrupt file blocks the install.
- Live ralph loops (`ralph-loop:<loop-id>`) — from the launcher registry
  with process-liveness checks.
- Live direct workers (`direct-worker:<invocation-id>`) — sampled with the
  same status reader `aiwg ralph-external --status --workers` uses, over the
  run directories AIWG launchers record (Mission Control session
  `*.run` dirs and registry `managedWorker.runDir` entries). Any worker
  whose state is not terminal (launching, started, active, quiet, stalled,
  hung) blocks; an incomplete or failed sample blocks too.
- Non-terminal Mission Control missions (`mission:<mission-id>`) — missions
  in `queued`, `running`, or `paused` status in
  `.aiwg/ralph-external/mc/sessions/*/session.json`. `done`, `failed`, and
  `aborted` missions do not block. Paused missions block: they still hold
  reservations and resume.

Hand-launched processes AIWG does not track cannot be detected. A worker
CLI started outside AIWG with no run directory, or any process that never
registered in the task store, loop registry, worker run dirs, or mission
sessions, is invisible to every detector above. Keep installs inside
maintenance windows and start one-off work through AIWG (`aiwg mc`, managed
loops) so the gate can see it.

## Recovery reporting

Every install writes a receipt with `oldVersion`/`newVersion`, success or
failure, and rollback guidance (`npm install --global aiwg@<old>` for npm
mode; re-resolve the previous signed release for web mode), plus the note
that provider redeploy was NOT performed. The latest outcome surfaces in
`aiwg housekeeper status` (JSON `update.lastInstall`, human `Last install:`
line). To acknowledge an interrupted run after inspecting effects:

```bash
aiwg housekeeper run-once --job <id> --resolve "inspected; <what you found>"
```

## Resource bounds

Top-level `resources` block in the daemon config (validated at startup;
invalid blocks fail loudly). Defaults are conservative:

| Bound | Default | Enforced by |
|---|---|---|
| `maxConcurrentJobs` (1–8) | `2` | runner: extra runs wait FIFO |
| `maxQueueDepth` (0–1024) | `16` | runner: beyond it the run is dropped with a persisted `queue-overflow` receipt |
| `maxTimeoutMs` (1000–3600000) | `600000` | runner: clamps every per-job `timeoutMs` |
| `jobNiceness` (-20–19) | `10` | owner children get lower CPU priority (plus idle IO class on Linux, best-effort) |
| `maxWatchHandles` (1–512) | `64` | watcher: roots beyond the cap stay on polling (B3 reconciliation), reported in `polling_roots` |

Timeouts, kills, and uncertain exits keep the existing semantics: an owner
that times out or is interrupted is `deferred`/`recovery-required`, never
replayed blindly.

## Benchmarks (measured, 2026-10-24)

`node tools/benchmarks/housekeeper.mjs [--files N] [--burst N]
[--idle-seconds S]`; temp data is always removed afterwards. Results on
Linux x64, Intel i9-14900KF (32 CPUs, 60 GiB), Node v24.22.1:

| Measurement | Result |
|---|---|
| Idle RSS (housekeeper daemon) | 75184 KiB |
| Idle CPU (housekeeper daemon, 5 s) | 0% |
| Burst: 200 changes delivered | 107 ms (0.54 ms/change) |
| Reconcile: 50000 files | 742 ms |

Re-run the script on your own host before capacity planning; treat the table
above as one data point, not a guarantee.

## Troubleshooting

- `queue-overflow` receipts: lower job frequency or raise `maxQueueDepth` /
  `maxConcurrentJobs`; each overflow names the bound that dropped it.
- `recovery-required` schedules: inspect effects first
  (`housekeeper.jobs` receipts, logs), then acknowledge with `run-once
  --resolve`; the runner never replays them on its own.
- Watch roots stuck in `polling_roots`: the handle cap or a platform limit
  parked them on polling; reconciliation still converges, only slower.
- `update.install` always defers on `edge`: expected — there is no
  read-only edge probe, so edge updates stay manual (`git pull`).

## Daemon-free alternatives

- Lazy reconciliation: run `aiwg housekeeper run-once --job <id>` from cron
  or manually; overlapping runs serialize on the task-store claim and
  duplicates are skipped by fire-time idempotency.
- systemd one-shots: `aiwg housekeeper install --systemd-user --with-timer`
  writes user units that call `run-once` (opt-in, never implicit).
- macOS without a daemon: foreground `start` or cron/launchd calling
  `run-once`; see `aiwg housekeeper --help`. Windows is unsupported — use
  WSL2 and follow the Linux rows.
