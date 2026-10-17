# Turn On Direct Worker Dispatch

> **First time using AIWG?** Begin with [Install, Connect, and Verify](install-connect-verify.md).

## What it does

AIWG can dispatch bounded pieces of work directly to other AI CLIs installed on your
machine (for example Codex or Muse), instead of only delegating inside the single
provider session you are talking to. This is controlled by one setting:
`parallelism.worker_dispatch` in `.aiwg/aiwg.config`. It is off by default.

When it is off, AIWG's model-selected delegation rubric still applies — the active
provider delegates to its own native subagents. When it is on, AIWG can also place
work directly onto other configured worker CLIs.

## What it costs

Direct dispatch uses your **other accounts' quota**. If AIWG dispatches a task to
Codex or Muse, that run consumes that tool's own API/account usage — not the
provider session you started from. Review the parallelism caps and worker
configuration before enabling it on a shared or metered account.

## How AIWG offers it

`aiwg init` and `aiwg setup project` detect which supported worker CLIs are
installed (a fast, local, presence-only check — no network call and nothing is
spawned). When two or more are detected and dispatch is off, the setup step asks
one yes/no question naming the detected CLIs. The default answer is **no**: nothing
is enabled without an explicit yes at a terminal, or an explicit config command.
After enabling and configuring workers, the next step is
`aiwg doctor --probe-workers --qualify`.

Until you answer, or whenever the question can't be asked (non-interactive runs,
CI, dry runs), `aiwg regenerate`, `aiwg refresh`, and `aiwg doctor --probe-workers`
print a single reminder line instead (naming the enable command) when dispatch is
still off and two or more worker CLIs are detected.

### Answering headlessly

`aiwg init` and `aiwg setup project` both accept `--worker-dispatch enable|decline`
directly, so a script or agent running either command without a terminal can answer
the question without waiting for the interactive prompt or leaving it unanswered:

```bash
aiwg init --non-interactive --worker-dispatch enable
aiwg setup project --yes --worker-dispatch decline
```

- `enable` writes `parallelism.worker_dispatch: true` and nothing else;
  `decline` writes `setup.worker_dispatch_offer: "declined"` and nothing else.
- With a terminal attached, passing the argument still answers the question
  directly — it is never asked.
- The argument is honored even when fewer than two worker CLIs are detected: an
  explicit choice always overrides the presence-only detection gate above.
- `--dry-run` never writes, even with the argument — it reports what would be
  written instead (`aiwg setup project --json --dry-run` reports it under
  `worker_dispatch_offer.applied_choice`). This holds for the whole command, not
  just the worker-dispatch increment: `aiwg init --dry-run` on a brand-new project
  writes nothing at all — not `.aiwg/aiwg.config`, not `AIWG.md`, not
  `WORKSPACE.md` (#3062 review item 18; previously it wrote the baseline config
  unconditionally even under `--dry-run`).
- An unrecognized value (anything other than `enable`/`decline`) exits non-zero
  naming the accepted values.
- Without a terminal and without the argument, behavior is unchanged (the
  one-line reminder above) except that the reminder now also names
  `--worker-dispatch` as the direct, headless way to answer it.

If you say no, AIWG remembers the decline (`setup.worker_dispatch_offer: "declined"`
— a setup preference, kept separate from the worker-policy settings above) and
stops offering it entirely: the question is not asked again, and none of the
reminder lines above print anymore either. The generated project context also
reflects the decline so agents don't keep re-offering it. To change your mind
later, just run the enable command below directly — turning dispatch on always
takes priority over a recorded decline, so there is no separate "undo the
decline" step.

## How to turn it on

```bash
aiwg config set --project parallelism.worker_dispatch true
```

Then confirm the CLIs AIWG would dispatch to are actually installed and launchable:

```bash
aiwg doctor --probe-workers
```

For machine-readable output (one record per CLI with `cli`, `installed`, `version`, `inRange`,
`ready`, `reason`, plus top-level `probeWorkers`/`workerDispatch`/`workersConfigured` fields),
add `--json` — stdout holds exactly that JSON document and nothing else:

```bash
aiwg doctor --probe-workers --json
```

With no worker CLIs configured, the text run prints one `Direct Worker` line saying so and how
to configure them; the JSON run reports `"workersConfigured": false` with the same guidance
in `message`. Add a complete entry with the required adapter and account/quota scopes, for example:

```bash
aiwg config set --project parallelism.clis.codex '{"adapter":"providers:codex","accountScope":"local-account","quotaScope":"local-quota"}'
```

When dispatch is disabled, JSON still includes every configured CLI with reason
`WORKER_DIRECT_DISABLED` and a message explaining that no probes ran.
Unknown `aiwg doctor` flags exit non-zero naming the flag.

## Supported CLI versions

Both the adapter and its invocation profile declare `supportedVersions`; the installed
version must satisfy both. These are semver ranges: space-separated comparators
are ANDed, so Codex's `>=0.161.0 <0.200.0` includes patch and minor updates from
0.161.0 up to, but excluding, 0.200.0. Muse uses `>=1.4.4-R5419.1 <2.0.0`, retaining
the originally evidenced build and accepting subsequent stable 1.x releases.

The shared matcher uses standard semver prerelease ordering: `1.4.4-R5419.1`
precedes `1.4.4`; prereleases are admitted only when a comparator explicitly
names a prerelease with the same major/minor/patch. Build metadata (`+build.1`)
does not affect precedence. Registered banner patterns extract the version before
matching; for example, `Muse Code 1.4.10 (1.4.10-R6427.1)` yields `1.4.10`.

Versions below the minimum or at/above an exclusive upper bound remain not-ready
with `WORKER_DIRECT_VERSION_OUT_OF_RANGE`. A matching version establishes
installation readiness; dispatch still requires the existing qualification checks.

## Qualify the installed CLIs

After configuring `parallelism.clis`, `parallelism.groups`, and the matching
`defaults.workerSelection.roleGuidance` in `models.json`, run:

```bash
aiwg doctor --probe-workers --qualify
```

Doctor probes the configured CLIs as usual, then asks one yes/no question listing
the ready installations and configured model/role approvals it will record. For
headless use, confirmation must be explicit:

```bash
aiwg doctor --probe-workers --qualify --yes
aiwg doctor --probe-workers --qualify --yes --cli codex --json
aiwg doctor --probe-workers --qualify --dry-run --json
```

Without a terminal, omitting `--yes` fails without recording approval. `--dry-run`
previews the records without writing them or asking for confirmation. `--cli`
limits both probing and qualification to that configured CLI. JSON mode emits a
single document, including the qualification results.

Approval trusts the installed CLI and bundled argument renderer for direct shell
operation. It records no live inference, backend identity, or negative sandbox
test result. Existing host inspection binds the executable bytes/version,
installed driver files, workspace, account scope, environment and worker policy.
The existing private `worker-installations.json` under `AIWG_CONFIG` (normally
`~/.config/aiwg`) also stores the existing model observation records with only the
configured models and roles qualified. Resolution revalidates the installation
before using those approvals. After a binary, driver, version, workspace or policy
change, rerun the qualify action.

Qualification rejects group/other-writable installed package paths. With a
shared-group umask such as `002`, secure the package first with
`chmod -R go-w <packageRoot>`; the error names the offending path. It never
changes package permissions automatically. Qualification can remove group/other
write bits from its own current-user-owned `AIWG_CONFIG` directory: the TTY
confirmation and `--dry-run` list `chmod go-w`, and `--yes` applies it. A directory
owned by another user is refused with its path.

`--brief`, `--workdir`, and `--final-output` require absolute paths. The brief may
be outside the workdir, but must remain inside the installation's qualified
worker-writable roots; paths through symlinks are rejected.

Qualification preserves observed catalog facts and discovery timestamps. Doctor
uses the existing read-only Codex/Muse catalog discovery or previously discovered
observations for other CLIs; it never calls a model. Missing exact inference
provider/model identity, unknown context limits, stale observations, data
policy restrictions, unsupported required controls, or denied efforts can still
block dispatch. The result lists configured models whose current observations
are missing. Refresh their model discovery and qualify again. Approval does not
change `models.json`, loosen data policy, or claim that a CLI can enforce child
limits; those policies must match the chosen harness's supported controls.

Codex discovery calculates usable context as
`floor(min(context_window, max_context_window) * effective_context_window_percent / 100)`
when those optional ceiling/percentage fields are reported; otherwise it uses
the reported active window without the missing adjustment. A maximum alone does
not establish the active window. The output limit stays unknown when the catalog
omits it. With a known context window, the fit check uses only the total context
bound and emits a non-blocking diagnostic that the output limit is unreported
and only the context window was checked. `qualifiedMaxOutputTokens` remains
`null`; unknown context limits still block dispatch. Codex and Muse
listed reasoning levels have explicit effort control; `ultra` is the catalog's
automatic task-delegation level, while the other listed levels do not self-delegate.
This effort fact does not establish the CLI's ability to control child agents.

Denials name the applicable `models.json` policy keys. An operator may permit
unknown data-use facts with `defaults.workerSelection.dataPolicy.allowUnknown: true`
and uncontrolled child agents with
`defaults.workerSelection.guards.denySelfDelegation: false`. These choices do not
qualify the missing facts or supply an output limit. Data-class restrictions still
apply. The plan resolver's premium authority requires
`request.authority.premiumAuthorized: true` and `request.authority.maxAutoTier: 3`;
`aiwg models resolve --authorize-premium` sets both for that resolution only.
Agents pass it only after the human explicitly confirmed the premium escalation
(escalation-discipline rule). It does not persist authorization or change policy.

Check a concrete brief with the existing resolver after qualification:

```bash
aiwg models resolve --role coding --task implementation --group workers \
  --brief "$PWD/brief.txt" --workdir "$PWD" --final-output "$PWD/result.json" --format json
```

## How to turn it off

```bash
aiwg config set --project parallelism.worker_dispatch false
```

Turning it off only changes this one setting — any per-CLI enablement
(`parallelism.clis`) and group configuration keep their existing values, so turning
dispatch back on later restores the same setup.
