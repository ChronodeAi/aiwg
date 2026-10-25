# Design note: housekeeper daemon reuse boundary (epic #3353, slice B1)

Status: proposed (gates B2–B4)
Date: 2026-10-24
Decision owners: AIWG maintainers
Related: #3353 (D1–D4), #3282–#3285 (owner contracts)

## Context

Epic #3353 decomposes the housekeeping daemon. The recorded decisions are:

- **D1**: REUSE the existing daemon (`tools/daemon/daemon-main.mjs`) as a
  minimal profile that lazily skips the conversational stack. No parallel
  scheduler subsystem.
- **D2**: in-daemon cron as primary; documented systemd units (autostart,
  native timers calling run-once) as the alternative.
- **D3**: update installs are check-only by default, install opt-in.
- **D4**: per-index configurable freshness targets, reporting measured
  convergence.

This note is slice B1: design only, no code. It pins the reuse boundary so
slices B2–B6 can be implemented against stable contracts. Every later slice
references its contract section (see §8).

Format follows the existing ADR convention in this directory (Status / Date /
Decision owners / Related / Context / Decision / consequences).

## 1. Reuse boundary: minimal housekeeper profile vs full stack

### 1.1 What the housekeeper profile LOADS

| Module | Entry point | Role in housekeeper profile |
|---|---|---|
| `Config` | `tools/daemon/daemon-main.mjs:6`, loaded at `tools/daemon/daemon-main.mjs:166` | Reads `daemon.profile` plus existing `watch` / `schedule` config. B2 adds the `housekeeper` profile key; validation stays in `tools/daemon/daemon-main.mjs:169`. |
| `EventRouter` | `tools/daemon/daemon-main.mjs:9`, constructed at `tools/daemon/daemon-main.mjs:195` | In-memory fan-out with retry + DLQ (`tools/daemon/event-router.mjs:3`, `maxRetries` at `:8`, DLQ at `:24`). Housekeeper keeps it as the only event bus. |
| `CronScheduler` | `tools/daemon/daemon-main.mjs:8`, started when `schedule.enabled` at `tools/daemon/daemon-main.mjs:294` | Primary trigger per D2. Minute-tick matcher at `tools/daemon/cron-scheduler.mjs:21`, emitting `cron.fired` with `{ job_id, action }` at `tools/daemon/cron-scheduler.mjs:28`. |
| `FileWatcher` | `tools/daemon/daemon-main.mjs:7`, started when `watch.enabled` at `tools/daemon/daemon-main.mjs:286` | Optional trigger for source-driven jobs. Recursive `fs.watch` at `tools/daemon/file-watcher.mjs:38`, per-key debounce at `tools/daemon/file-watcher.mjs:61`. B3 makes watch events hints to deterministic reconciliation, including startup, periodic scans and recovery; cron remains the scheduling source of truth. |
| `IPCServer` (minimal method subset) | `tools/daemon/daemon-main.mjs:10`, started at `tools/daemon/daemon-main.mjs:281` | Keeps `ping` (`tools/daemon/daemon-main.mjs:558`), `daemon.status` (`:437`), `schedule.status` (`:656`), plus the new `housekeeper.*` methods from §6. All other methods (§1.2) are not registered in this profile. |
| `TaskStore` (receipts implemented by B2) | `tools/daemon/daemon-main.mjs:12`, initialized at `tools/daemon/daemon-main.mjs:198` | Persistence substrate only. Its current corrupt-file behavior (silent fresh start, `tools/daemon/task-store.mjs:43`) is NOT adopted: B2 implements persisted receipts and unified schedule recovery (§2.1, `JobReceipt`). |
| Process plumbing | pid/lock/heartbeat/state/log/socket paths at `tools/daemon/daemon-main.mjs:52`, signal handlers at `:113`, log rotation at `:133`, heartbeat/state writers at `:717` / `:729` | Unchanged. The single-instance lock (`tools/daemon/daemon-main.mjs:94`, `EEXIST` exit at `:99`) is what serializes background + foreground writers until B6 wires per-root locks (`src/resources/lockfile.ts`, `src/effects/lock-recovery.ts`). |

### 1.2 What the housekeeper profile SKIPS, and how

Skipped subsystems are gated by a profile check at the top of
`initializeSubsystems` (`tools/daemon/daemon-main.mjs:188`), so none is
constructed and none can emit model calls:

| Skipped | Current construction site (NOT reached in this profile) | Why |
|---|---|---|
| `MemoryManager` | `tools/daemon/daemon-main.mjs:190` | Conversational context; scheduling must not grant memory mutation authority (B6). |
| `AgentSupervisor` | `tools/daemon/daemon-main.mjs:205` | Spawns `claude -p` subprocesses; the housekeeper runs deterministic owner CLI/APIs instead. |
| `DaemonSupervisor` | `tools/daemon/daemon-main.mjs:218` | Governance wrapper around the agent supervisor; nothing to govern without agents. |
| `BehaviorRegistry` / `DaemonBehaviorLoader` | `tools/daemon/daemon-main.mjs:243` / `:258` | Injectable orchestrators for the conversational stack. |
| `MessageRouter` | `tools/daemon/daemon-main.mjs:267` | Broadcasts supervisor events; no supervisor exists here. |
| `AutomationEngine` | `tools/daemon/daemon-main.mjs:271` | Trigger-action rules over agent tasks; replaced by the §2.1 job dispatcher (B2). |
| `RoomManager` / messaging hub | dynamic `import()` at `tools/daemon/daemon-main.mjs:304` / `:317` | Already lazy — the existing precedent for lazy loading. The profile flag simply never reaches these lines. |
| `ScheduledTaskRunner` | `tools/daemon/daemon-main.mjs:331` | Its built-ins map to *agent prompts* (`tools/daemon/scheduled-task-runner.mjs:18`); superseded by the deterministic dispatcher (B2, §2.1). Its `cron.fired` subscription shape (`tools/daemon/scheduled-task-runner.mjs:77`) is the pattern the dispatcher reuses. |
| `AutonomousEngine` | `tools/daemon/daemon-main.mjs:344` | Autonomous agent loops; explicitly out of scope. |
| `ProviderWatcher` | `tools/daemon/daemon-main.mjs:359` | Provider-diff PR automation; update checks go through the §2.4 owner route instead (D3). |
| `WebServer` | `tools/daemon/daemon-main.mjs:396` | HTTP surface; housekeeper exposes IPC + JSON status only (§6). |
| Conversational IPC methods | `chat.send` at `tools/daemon/daemon-main.mjs:527`, `memory.*` at `:561`, `behaviors.*` at `:594`, `autonomous.*` at `:631`, `task.submit/cancel` at `:455`/`:468` | Not registered in this profile. `task.list/get/stats` (`:478`/`:485`/`:500`, read-only over the store) MAY be registered read-only so `status --json` can cite receipts. |

### 1.3 Lazy-import mechanism

- The profile decision is a config value (`daemon.profile: "housekeeper"`,
  new in B2) read in `loadConfig` (`tools/daemon/daemon-main.mjs:165`)
  before `initializeSubsystems` (`tools/daemon/daemon-main.mjs:188`).
- Gating is by early branch, not by deleting imports: the static imports at
  `tools/daemon/daemon-main.mjs:6` are side-effect-free class definitions, so
  skipping construction is sufficient to guarantee zero model calls. B2 MAY
  convert them to dynamic `import()` on the RoomManager precedent
  (`tools/daemon/daemon-main.mjs:304`) for faster startup, but that is an
  optimization, not a correctness requirement — reviewers must not block B2
  on it.
- `stopSubsystems` (`tools/daemon/daemon-main.mjs:784`) and SIGHUP reload
  (`tools/daemon/daemon-main.mjs:176`) keep working: skipped fields stay
  `null` and the existing null-guards already handle that.

## 2. Adapter contracts

All interfaces are TypeScript-style and documentary: B2–B6 implement them in
whatever module layout they choose, but the shapes below are normative. Field
names are exact; additive optional fields are allowed.

### 2.1 Scheduled-job contract (B2 implements and persists)

Replaces the prompt-based `BUILTIN_ACTIONS`
(`tools/daemon/scheduled-task-runner.mjs:18`) with deterministic operations.
The cron payload `{ job_id, action }`
(`tools/daemon/cron-scheduler.mjs:28`) is extended, never reinterpreted:

```ts
/** One registered housekeeping job. Configured under `schedule.jobs`. */
interface HousekeeperJob {
  id: string;                    // == cron job_id; stable across restarts
  kind: JobKind;                 // closed union — no free-form prompts
  schedule?: string;             // cron expression (alias: cron); absent for manual memory.apply
  args?: Record<string, unknown>; // owner args, including reviewed plan/digest and optional windows
  idempotencyKey?: string;       // default: `${id}:${scheduledFireMinute}`
  timeoutMs: number;             // per-kind default, overridable
  retries: 0 | 1 | 2;            // re-entrant kinds only (see §5)
}

type JobKind =
  | 'index.refresh'    // B4: run one index adapter refresh
  | 'index.freshness'  // B4: probe only, emit freshness state
  | 'update.check'     // B6: check-only version probe (D3)
  | 'index.verify' | 'index.reconcile' | 'cache.retention' // existing aliases
  | 'update.install'   // B6 part 1: explicitly opted-in package install
  | 'memory.audit'     // B6 part 2: read-only versioned inventory
  | 'memory.recommend' // B6 part 2: advisory report; never creates plans
  | 'memory.apply'     // B6 part 2: exact reviewed plan + recorded digest only
  | 'cache.prune';     // B6: bounded cache cleanup (src/resources/cache-cleanup.ts)

/** Typed receipt written for every settled job (B2 persists). */
interface JobReceipt {
  jobId: string;
  fireTime: string;              // ISO; the scheduled minute, not start time
  state: 'ok' | 'failed' | 'skipped' | 'deferred';
  reason?: string;               // machine-readable: lock-held, gate-denied, …
  startedAt: string; finishedAt: string;
  durationMs: number;
  detail?: RefreshSummary | UpdateCheckSummary | PruneSummary; // per-kind
}
```

Dispatcher rules: unknown `kind` warns and returns (the
`scheduled-task-runner.mjs:104` precedent); a job whose idempotency key
already has a terminal receipt for the same `fireTime` is `skipped`
(duplicate delivery from overlapping cron + run-once is normal, §5).

### 2.2 Index-adapter contract (B4 implements)

Wraps the existing refresh entry point — `runIndexRefresh(args, cwd, signal)`
with `--workspace/--root/--only/--dry-run/--json`
(`src/artifacts/index-refresh.ts:527`) — and its report envelope
(`contractVersion/command/status/mode/jobs/totals`,
`src/artifacts/index-refresh.ts:579`). The serial/worker preparation core
(`prepareIndexArtifact`, `src/artifacts/index-builder.ts:938`) and the
checksum-manifest reuse (`src/artifacts/index-builder.ts:36`) are reused
unchanged; the adapter supplies per-index identity and policy:

```ts
interface IndexAdapter {
  /** Canonical name, must match one `--only` value or a registered index. */
  name: 'graphs' | 'sessions' | 'caches' | 'runtime' | 'models' | 'issues';
  /** Roots this index covers; maps index → canonical roots/identity. */
  roots(cwd: string): string[];
  /** Cheap probe: no build. Returns current freshness state. */
  probe(cwd: string): Promise<FreshnessState>;
  /** Full refresh via runIndexRefresh; args mirror its CLI flags. */
  refresh(opts: { cwd: string; full?: boolean; dryRun?: boolean;
                  signal?: AbortSignal }): Promise<RefreshSummary>;
  /** D4: did the last refresh converge within target? Measured, not asserted. */
  convergence(last: RefreshSummary): ConvergenceReport;
}

type FreshnessState = 'fresh' | 'stale' | 'degraded' | 'unsupported';
```

Freshness semantics: `stale` = older than the per-index target;
`degraded` = probe or last build errored but serving reads is still safe;
`unsupported` = index not registered on this backend (never retried
aggressively — backs off to daily probes). `all`-mode discovery of newly
registered indices and the "changes during build leave another reconciliation
pending" case are B4 responsibilities, reported as `deferred` receipts.

```ts
/** D4: per-index configurable freshness targets (housekeeper config). */
interface FreshnessPolicy {
  index: IndexAdapter['name'];
  targetStaleAfterMs: number;   // when `fresh` becomes `stale`
  maxRetriesPerDay: number;     // backoff ceiling for failing indices
  measureConvergence: boolean;  // default true: report wallMs + manifest delta
}
interface ConvergenceReport {
  converged: boolean;           // fresh within target after refresh?
  wallMs: number;               // measured, from RefreshReport.totals
  residualJobs: number;         // jobs still non-ok (pending reconciliation)
}
```

### 2.3 Owner-routing contract (B6 implements; B2/B4 call into it)

Scheduling must not grant extra mutation authority: jobs may only invoke the
owner operation the owning slice exposes, with the caller's authority. The
router is a closed table, not a plugin system:

```ts
interface OwnerRoute {
  jobKind: JobKind;              // each kind has exactly one owner
  owner: string;                 // owning slice/issue, e.g. '#3282'
  /** Deterministic owner entry point (CLI handler or exported function). */
  invoke: (args: Record<string, string>) => Promise<JobReceipt['detail']>;
  /** True when this route may mutate; false = probe/check only. */
  mutating: boolean;
}
```

Invariants: `update.check` routes with `mutating: false` (D3 — install needs
an explicit opt-in flag that scheduled runs never set); memory/index owner
mutations respect stale-plan and protected-item rules from #3282–85 (B6
integrates against the delivered owner contracts, which this note does not
redefine); `refreshHandler` (`src/cli/handlers/refresh.ts:530`, framework
redeploy) is NOT an owner route — scheduled jobs never redeploy frameworks.

### 2.4 Resource-gate contract (B2 implements; every job passes through it)

Before ANY job runs — including probes — the gate runs preflight so shared
hosts are not swamped. Denial yields a `deferred` receipt with
`reason: 'gate-denied'`, never a failure:

```ts
interface ResourceGate {
  /** Load/memory/disk preflight. Returns pass or the denying reason. */
  preflight(): Promise<{ pass: true } | { pass: false; reason: string }>;
}
interface GatePolicy {
  maxLoad1?: number;             // 1-minute loadavg ceiling
  minFreeMemBytes?: number;
  minFreeDiskBytes?: number;     // checked on cwd filesystem + TMPDIR fs
  quietHours?: string[];         // cron ranges during which jobs defer
}
```

Defaults are conservative (gate denies on unknown/unreadable metrics rather
than admitting blind). Active-work coordination (foreground `aiwg` running,
maintenance windows) is B6 scope via the owner contracts.

## 3. Platform matrix

No platform units exist today (no systemd/launchd/service files in the repo);
B5 authors them. D2 makes in-daemon cron primary and systemd the documented
alternative. Honest support table:

| Platform | Daemon profile (in-daemon cron) | Run-once path | Status |
|---|---|---|---|
| Linux + systemd | user unit `aiwg-housekeeper.service`, autostart via `loginctl enable-linger` or graphical session | `aiwg-housekeeper.timer` (or cron `(5)`) invoking `aiwg housekeeper run-once` | Documented (B5). Primary alternative per D2. |
| Linux w/o systemd | foreground `aiwg housekeeper start` under tmux/nohup | cron or manual `aiwg housekeeper run-once` | Supported-manual; same binary, no unit file. |
| macOS | foreground `aiwg housekeeper start` | `launchd` plist (`StartCalendarInterval`) invoking `run-once` | Best-effort: plist example documented by B5, not CI-tested (no macOS runner). `fs.watch` recursion works on macOS; B3 provides configurable polling fallback. |
| Windows | — | — | NOT supported. No service wrapper, no `fs.watch(recursive)` on Windows, and `runIndexRefresh` paths assume POSIX layouts. WSL2 → follow the Linux rows. Say so in help text; do not probe-detect and fake support. |
| CI / containers | `run-once --job <id>` | same | Supported: single-shot, no daemon, exit code reflects receipt (§5). |

`start` = long-lived profile process (loads §1.1 only); `run-once` = execute
exactly one job dispatch + gate + receipt, then exit (§5). Both are new CLI
surface: zero `housekeeper` hits exist in
`src/extensions/commands/definitions.ts` today (cf. `daemon-init` at
`src/extensions/commands/definitions.ts:3302`), so the whole
`start|stop|status|run-once` family plus job/watch registration is B2 scope.

## 4. Run-once semantics, idempotence, temp-dir hygiene, logging

- **Single dispatch.** `run-once [--job <id>] [--dry-run] [--json]` resolves
  one `HousekeeperJob`, runs gate → owner route → receipt, prints the receipt,
  exits. No watcher, no scheduler, no IPC server, no lock file held beyond the
  job's own owner lock.
- **Idempotence.** Receipts are keyed `(jobId, fireTime)`; re-running the same
  fire minute returns the stored receipt with `state: skipped` instead of
  re-executing (§2.1). Non-reentrant kinds (`update.check` with install flag —
  which scheduled runs never set per D3) additionally take the owner lock;
  `lock-held` yields `deferred`, never queueing.
- **Exit codes.** `0` = receipt `ok`/`skipped`; `1` = `failed`; `2` = bad
  invocation; `3` = `deferred` (so timers/cron can distinguish "try next
  tick" from failure without paging). Mirrors the existing refresh convention
  where `report.totals.errors` sets the exit code
  (`src/artifacts/index-refresh.ts:576`, `src/cli/router.ts:94`).
- **Temp-dir hygiene.** Jobs MUST create scratch space under `$TMPDIR` (never
  the repo), MUST remove it on all paths including gate-denial and timeout,
  and MUST leave zero residue: B2 adds a CI gate asserting empty temp dirs
  after `run-once` (the TMPDIR leak gate referenced by the epic). Long-lived
  daemon mode reuses the existing `.aiwg/daemon/` state files
  (`tools/daemon/daemon-main.mjs:52`) — receipts live there, scratch never
  does.
- **Logging.** Daemon mode appends to the existing rotated log
  (`tools/daemon/daemon-main.mjs:56`, rotation at `:133`). `run-once` logs to
  stdout/stderr only (container/systemd-journal friendly) plus the persisted
  receipt. `--json` emits the receipt and nothing else on stdout, so timers
  can parse it.

## 5. Non-goals (explicit)

1. No parallel scheduler subsystem (D1). One in-daemon cron
   (`tools/daemon/cron-scheduler.mjs:21`) plus external timers calling
   run-once (D2). Anything needing distributed coordination is out.
2. No model calls in the housekeeper profile. `AgentSupervisor`
   (`tools/daemon/daemon-main.mjs:205`) and all prompt-based built-ins
   (`tools/daemon/scheduled-task-runner.mjs:18`) are skipped, not adapted.
3. No new mutation authority. Owner routing (§2.3) only invokes authority the
   owner already grants; B6 enforces stale-plan/protected-item rules.
4. Watcher reliability is B3 scope: reconciliation converges source changes;
   cron remains the scheduling authority. Watcher recovery grants no owner
   mutation or independent retry authority.
5. No framework redeploy from schedule. `refreshHandler`
   (`src/cli/handlers/refresh.ts:530`) and the `index refresh` router
   short-circuit (`src/cli/router.ts:90`) keep their foreground semantics;
   scheduled index work goes through `runIndexRefresh`
   (`src/artifacts/index-refresh.ts:527`) via §2.2.
6. No Windows service support (§3). Documented as unsupported, not attempted.
7. No unified cross-process lock service yet. Single-instance lock
   (`tools/daemon/daemon-main.mjs:94`) plus per-root files
   (`src/resources/lockfile.ts`, `src/effects/lock-recovery.ts`) are composed
   by B6; this note only requires `lock-held → deferred`.

## 6. Discoverable help / JSON-status shape (B2 implements)

`aiwg housekeeper --help` lists `start|stop|status|run-once` with one line
each, the platform support note (§3, Windows line included), and the D3
check-only default. Machine surface:

```ts
/** `aiwg housekeeper status --json` and `daemon.status` housekeeper section. */
interface HousekeeperStatus {
  profile: 'housekeeper';
  pid: number | null;            // null when daemon not running (run-once context)
  uptimeSeconds: number;
  jobs: { id: string; kind: JobKind; lastState: JobReceipt['state'] | 'never';
          lastRun: string | null; nextFire: string | null }[];
  freshness: { index: string; state: FreshnessState; targetMs: number;
               converged: boolean | null }[];   // D4, measured per §2.2
  update: { channel: string; checkOnly: true; lastCheck: string | null;
            available: boolean | null };         // D3
}
```

Extends, not replaces, the existing `daemon.status` shape
(`tools/daemon/daemon-main.mjs:437`) and `state.json` writers
(`tools/daemon/daemon-main.mjs:729`).

## 7. Dependency matrix

| Depends on | Needed for | Contract section |
|---|---|---|
| #3282–85 owner contracts (memory maintenance owners) | Which mutations schedule may invoke; stale-plan + protected-item rules | §2.3 (B6 integrates; this note grants nothing) |
| Index owners (per-index registration, `all`-mode discovery) | Adapter `roots()` mapping; `unsupported` handling | §2.2 (B4) |
| `runIndexRefresh` / preparation core (`src/artifacts/index-refresh.ts:527`, `src/artifacts/index-builder.ts:938`) | Refresh execution reused unchanged | §2.2 |
| Update checker channels (`src/update/checker.mjs:5`, fail-soft nulls at `:30`) | Check-only probes reused; policy/preflight/install distinction is new | §2.3 + §2.4 (B6) |
| Lock primitives (`src/resources/lockfile.ts`, `src/effects/lock-recovery.ts`) | `lock-held → deferred` coordination | §5.7 (B6) |

No slice may widen an owner contract: if an owner cannot express a scheduled
operation deterministically, the job stays unwired and the status surface
reports the index/owner as `unsupported` — never a prompt fallback.

## 8. B2–B6 mapping onto this note (gating checklist)

- **B2 — profile + dispatcher + run-once CLI.** Implements §1 (profile flag,
  skip list), §2.1 (`HousekeeperJob`, dispatcher, idempotency), §2.4
  (resource gate), §4 (run-once, exit codes, temp hygiene + CI gate), §6
  (help/JSON). References: §1.1 load table, §1.2 skip table, §1.3 laziness
  rule.
- **B3 — watcher hardening + reconciliation** (scope updated by #3353 B3).
  B2 owns persisted receipts and schedule recovery. B3 extends the existing
  `FileWatcher` and `EventRouter`, using `schedule-recovery-required` for
  uncertain watcher delivery outcomes without a transient DLQ retry.
  Deterministic stat scans run at startup, after coalesced native hints (including
  missing filenames), errors/overflow, root return, and periodically. Signatures
  use size, mtime, ctime, and inode without reading file contents. Native
  events are hints; scans honor each logical root's ignore/extension/event
  filters. Startup catch-up also emits modifications for modify-only roots.
  `watch.reconcile_interval_ms` defaults to 60000; zero disables routine scans.
  `watch.polling` (default false) can be overridden on each `watch.paths` entry;
  polling and unavailable-root probes use `watch.poll_interval_ms` (default
  5000), independently of routine scans, scanning only polling, unavailable, or
  uncovered unwatched roots. ENOSPC/EMFILE and unsupported recursive
  watches switch that root to polling and report it. Root inode replacement
  reattaches native watches; nested roots share a native watch while retaining
  their separate scan policies. Symlinks are not followed.
  `watch.generated_output_paths` excludes absolute or cwd-relative outputs;
  root-level overrides are relative to that root. Built-in daemon/working
  exclusions remain. An unavailable root retains its last good snapshot; a
  failed descendant scan retains that subtree and emits `scan-incomplete` with
  its path and error code while siblings keep converging. Neither case emits
  deletions for unreadable entries. Debounce coalesces by path; a rename changes
  the old and new paths, while an atomic replacement is one modification.
  Awaited delivery queues changes during builds and leaves a further scan
  pending. Failed delivery blocks until explicit inspection/acknowledgement
  (`FileWatcher.resume()`), or startup reconciliation after restart. Stopping
  cancels pending work; no scan snapshot is persisted or trusted across restart.
  `EventRouter.route()` retains synchronous history/fan-out behavior; the
  daemon watcher bridge uses the additive awaited `deliver()` method.
- **B4 — index adapters + freshness/convergence.** Implements §2.2
  (`IndexAdapter`, `FreshnessPolicy`, `ConvergenceReport`) over
  `src/artifacts/index-refresh.ts:527`; owns `all`-mode discovery and
  pending-reconciliation reporting. References: §2.2, §7 index-owner row.
- **B5 — platform units + install docs.** Authors the §3 systemd units,
  launchd plist example, WSL note, and the unsupported-Windows help line.
  References: §3 table, D2.
- **B6 — owner integration (memory, updates, locks).** Implements §2.3 owner
  table against delivered #3282–85 contracts, D3 check-only/install opt-in
  via `src/update/checker.mjs`, per-root lock composition, maintenance
  windows in §2.4 `GatePolicy`. Memory audit/recommend write versioned reports
  through the configured artifact root. Memory apply requires `args.plan` and
  `args.confirmedDigest` at registration, recomputes the digest, and preserves
  owner preview/version, protection, review, provenance and restore contracts.
  It verifies after apply; refusals, partial results and verification findings
  block for explicit recovery without retries. Fully applied owner receipts
  yield a read-only verified no-op. An apply job without a cron is manual
  one-shot only. Resource bounds and maintenance windows still apply. References: §2.3 invariants, §2.4, §7.

## Testable invariants (for B2–B6 acceptance)

1. Housekeeper profile process never constructs `AgentSupervisor`,
   `DaemonSupervisor`, `AutonomousEngine`, or `WebServer` (§1.2).
2. Zero model-subprocess spawns in any scheduled or run-once execution (§5.2).
3. Every settled job leaves exactly one `JobReceipt`; re-fire of the same
   `(jobId, fireTime)` skips without re-execution (§2.1, §4).
4. Gate denial yields `deferred`, never `failed` (§2.4).
5. `run-once --json` stdout parses as a single receipt/status object; temp
   dirs are empty afterwards (§4).
6. Freshness states and convergence numbers are measured from refresh
   reports, never asserted from config (D4, §2.2).
7. Scheduled update checks never install; `update.install` requires explicit
   per-job opt-in (D3, §2.3).
8. Memory scheduling grants no mutation authority: only the named reviewed
   plan can apply, with its recorded digest and unchanged owner preconditions.
   Stale/protected refusals and verification findings require recovery.
9. Windows reports unsupported; it never half-runs (§3).
