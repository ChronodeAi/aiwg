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
  `worker_dispatch_offer.applied_choice`).
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

## How to turn it off

```bash
aiwg config set --project parallelism.worker_dispatch false
```

Turning it off only changes this one setting — any per-CLI enablement
(`parallelism.clis`) and group configuration keep their existing values, so turning
dispatch back on later restores the same setup.
