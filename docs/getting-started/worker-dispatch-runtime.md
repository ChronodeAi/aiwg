# Worker dispatch runtime

> **First time using AIWG?** Begin with [Install, Connect, and Verify](install-connect-verify.md).

Continue from [Worker dispatch](worker-dispatch.md) after configuring groups and role guidance.

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
single document, including the qualification results and an
`qualification.accountScopeNotice` explaining the account approval limitation.

Approval trusts the installed CLI and bundled argument renderer for direct shell
operation. It records no live inference, backend identity, or negative sandbox
test result. Existing host inspection binds the executable bytes/version,
installed driver files, workspace, configured account scope label, non-PATH environment
and worker policy.
The existing private `worker-installations.json` under `AIWG_CONFIG` (normally
`~/.config/aiwg`) also stores the existing model observation records with only the
configured models and roles qualified. Resolution revalidates the installation
before using those approvals. After a binary, driver, version, workspace or policy
change, rerun the qualify action.

When recorded installations are refused, `WorkerPolicyError` keeps the
`OG_ADAPTER_UNQUALIFIED` code and includes fixed reason codes in its message and
`details.rejections`. Each rejection identifies the zero-based registration index
(or `null` for a store-level failure) and a reason such as `store-untrusted`,
`binding-mismatch`, `effective-config-digest`, `evidence`, `environment-name`,
`adapter-conflict`, `module-registration`, `binary-identity`, `scope-digest`, or
`version`. The launcher includes these codes on stderr. Rejection details omit
underlying error text, environment values, file contents, and filesystem paths.

Doctor checks each observed configured member/role with a synthetic brief through
the same nonlaunching invocation builder and native argument checks as resolution.
JSON output includes `invocationChecks` with the model, effort and workdir checked.
A failed build prevents qualification and reports `WORKER_DIRECT_INVOCATION_BLOCKED`
with `ready: false`; `inRange` still describes the version probe. Subsequent probes
repeat these checks for recorded installations. These checks do not replace the
resolver's policy and concrete request-path checks.

Account approval is per configured `parallelism.clis.<cli>.accountScope` label
only (default: `local-account`), not the native CLI's authenticated account.
Qualification does not read credential files or fingerprint tokens. Logging out
and signing into a different account under the same `HOME`/`CODEX_HOME` and label
does not invalidate existing installation or model/role approvals. The new
account may have different quota and data-use terms. After switching accounts,
set a distinct, non-secret label, refresh model discovery, and requalify before
dispatching:

```bash
aiwg config set --project parallelism.clis.codex.accountScope local-codex-account-2
aiwg models refresh
aiwg doctor --probe-workers --qualify --yes --cli codex
```

Use the configured CLI id in place of `codex`. Changing the label blocks use of
the previous approvals until fresh discovery and qualification are recorded.
Doctor includes this limitation in its confirmation question and qualification
results, including `--dry-run` and `--json` output.

Qualification rejects group/other-writable installed package paths. With a
shared-group umask such as `002`, secure the package first with
`chmod -R go-w <packageRoot>`; the error names the offending path. It never
changes package permissions automatically. Qualification can remove group/other
write bits from its own current-user-owned `AIWG_CONFIG` directory: the TTY
confirmation and `--dry-run` list `chmod go-w`, and `--yes` applies it. A directory
owned by another user is refused with its path.

`--task` is required: use `inventory`, `implementation`, `architecture`, `review`,
or a class configured in `defaults.workerSelection.taskClasses`. Missing task
arguments are rejected before configuration is loaded.

`--brief`, `--workdir`, and `--final-output` require absolute paths. Relative
paths produce a diagnostic naming the flag and its `/request` field; they are
not resolved against the current directory or workdir. The brief may
be outside the workdir, but must remain inside the installation's qualified
worker-writable roots; paths through symlinks are rejected.
The workdir must match the workspace used during qualification. A different
worktree reports `qualified_workspace_mismatch` at `/request/workdir`; qualify
from that worktree before resolving there. Build and preparation failures include
fixed `reason` identifiers (`invocation_build_failed`, `native_argv_invalid`, or
`invocation_prepare_failed`) and pointers to the failing invocation stage, in both
JSON plans and shell-mode refusals. Internal error text remains redacted.

Shell commands use `env -i` and pass only names from the qualified profile.
Process profiles retain PATH; Codex includes `env -i CODEX_HOME="${CODEX_HOME-}" HOME="${HOME-}" PATH="${PATH-}"`.
The conductor expands values; plans never print them. PATH is pass-through host plumbing:
its allowlisted name is recorded; its value is excluded from the pinned digest and launch equality check.
PATH lets Codex find the system `bwrap` allowed by AppArmor on Ubuntu.
Empty prepended directories preserve approval; another CLI realpath or SHA-256 blocks dispatch.
Other values stay bound and private. Requalify once when upgrading PATH-bound approvals.

Codex qualification also runs `codex sandbox` with a sandboxed `/bin/sh -c true`
under the same cleared, allowlisted environment. A failed sandbox check blocks
approval without calling a model. This checks shell startup, not full sandbox
attestation or model behavior. For groups with `execution.sandbox: "external"`,
this check is reported as skipped because the CLI sandbox is intentionally off.

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
aiwg models resolve --role coding --task implementation --group harness \
  --brief "$PWD/brief.txt" --workdir "$PWD" --final-output "$PWD/result.json" --format json
```


## Running outside the conductor sandbox

Run the rendered worker command from your own shell **outside your own harness
sandbox**, using Claude Code `sandbox.excludedCommands` or an unsandboxed Bash
call. The worker CLI's native sandbox, per-task worktree and resource scope
provide isolation. Never nest sandboxes: a CLI sandbox inside a conductor
sandbox fails.

If the worker's own sandbox cannot start on the host (for example, Muse under
Ubuntu's AppArmor user-namespace restriction), explicitly opt in through a
separate group. Merge this example with your existing configuration; keep the
usual sandbox policy for other groups and add `muse-external` to the coding
role's `groups` in `models.json`:

```json
{
  "parallelism": {
    "groups": {
      "muse-external": {
        "maxParallel": 1,
        "members": [
          { "id": "muse-host", "cli": "muse", "model": "muse-spark-1.3", "roles": ["coding"] }
        ],
        "execution": {
          "isolation": "worktree",
          "sandbox": "external",
          "approval": "never",
          "transport": "shell"
        }
      }
    }
  }
}
```

For Codex, `external` renders `-s danger-full-access`; for Muse it renders
`--disable-sandbox`, with approvals still `never` and Muse's judge off. Resolver
JSON reports the non-blocking `OG_SANDBOX_EXTERNAL` diagnostic. This is opt-in,
never the default, and cannot be combined with `launchMode: "native-sandbox"`.

Disabling the CLI sandbox removes its filesystem and network enforcement;
isolation then relies on the worktree and launcher resource scope, which do not
replace those protections. Use this only for trusted tasks with the host access
you intend to grant.

## Worker launch boundary on Linux

This section covers AIWG's own launcher: `aiwg ralph-external --launch-worker`
and managed-tier launches. It does not apply to Tier 0 direct
handoff, the default. In Tier 0 the conductor runs the command rendered by
`aiwg models resolve --transport shell --format shell` from its own shell outside the
conductor harness's sandbox; no systemd unit is created.

Launcher workers use a systemd user unit by default (`execution.launchMode: "systemd-unit"`),
with cgroup memory limits and a cgroup kill scope. For Codex `read-only` and
`workspace-write` sandboxes, the launcher first runs a bounded, non-inference
user/network namespace probe inside a transient user unit using the worker's
client environment handling. `aiwg doctor --probe-workers` reports this same
check in `sandboxChecks` with `scope: "systemd-launcher"`. A blocked check is a
warning, not a qualification failure: Tier 0 direct dispatch stays ready, and
the launcher re-probes and refuses at launch time.

Ubuntu hosts can restrict unprivileged user namespaces inside systemd user units
through AppArmor (`kernel.apparmor_restrict_unprivileged_userns=1`) even when
sandboxing works in an interactive shell. A failed
probe refuses launch before creating run metadata with
`OG_NATIVE_SANDBOX_UNAVAILABLE`, the bounded probe failure, and remediation.
The same code identifies known runtime `uid_map` and bwrap loopback permission
failures. A host administrator can configure an AppArmor allowance for the worker
launch path.

Alternatively, explicitly select the CLI sandbox as the launch boundary in the
project's `.aiwg/aiwg.config`, for each affected worker group:

```json
{
  "parallelism": {
    "worker_dispatch": true,
    "groups": {
      "workers": {
        "execution": {
          "launchMode": "native-sandbox",
          "sandbox": "workspace-write",
          "approval": "never",
          "network": "deny",
          "transport": "shell"
        },
        "members": [
          { "id": "primary", "cli": "codex", "model": "<approved-model>", "roles": ["coding"] }
        ]
      }
    }
  }
}
```

This mode is off by default and requires the verified Codex native shell renderer
with an explicit `read-only` or `workspace-write` sandbox. External, disabled,
unknown, and full-access sandboxes are refused. Environment variables, launch
flags, and `--allow-degraded-worker` do not opt in.
Config validation rejects `approval: "on-request"`, `network: "allowlisted"`,
and any group member whose installation uses a non-Codex adapter in this mode.
The MCP `worker-invoke` tool's `run` operation refuses pinned `native-sandbox`
invocations with `OG_POLICY_RELAXATION` until it supports this launch boundary.

The launcher uses its owned process group without a systemd unit and skips the
unit namespace probe. **There is no cgroup memory limit or cgroup kill scope; the
CLI's own sandbox is the only security boundary.** Process-group supervision and
timeouts still apply, but escaped descendants cannot be proven stopped, so
termination evidence remains uncertain. Run evidence and launch events identify
`native-sandbox` explicitly.

The host resource gate and saved-plan revalidation still apply. Launch mode is
pinned in the config digest and resolved invocation; changing it requires a fresh
`models resolve` plan. After changing the policy, run
`aiwg doctor --probe-workers --qualify --yes` and resolve again.

## Cross-family review evidence

The resolver's `reviewOf` and `requireDifferentFamily` check observed lineage.
Different CLI names do not establish different families; different families do
not establish independent errors. Agreement is not proof, including same-vendor and cross-vendor agreement. Consequential claims require an executable check or accountable human acceptance. Prefer independent voting, or structured review with diverse initial answers and calibrated confidence, over plain debate. Record observed evaluator model/vendor/family, acceptance criteria reference, generator/evaluator disagreements and a re-review link after material fixes. Do not claim reduced human-review time. See `docs/decision/evaluator-calibration.md` for calibration and REF-2922, REF-2923, REF-2919/2921 public sources.
