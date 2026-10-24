# Guided setup: interview, review, apply

After installing Node.js 24+ and the full `aiwg` package, open a terminal in
the intended project. The [public installer](https://aiwg.io/setup.aiwg.yaml)
can handle bootstrap and repair in your provider session. It remains a
provider-orchestrated manifest; `aiwg setup-run` does not execute it.

## Save the interview plan

```bash
aiwg setup --scope project --providers claude
```

Replace `claude` with your provider, or use a comma-separated list such as
`claude,codex`. Explicit flags win over saved answers and existing settings.
The interview asks about targets, intent, tools, locations, and optional
capabilities. It writes a plan beneath the configured AIWG artifact root at
`setup/plans/<plan-id>.json`, not provider configuration. The default plan ID
is derived from the current workspace. `aiwg init --scope project` also enters
the guided interview; plain `aiwg setup project` retains repository-policy
setup behavior. Include `--scope` to select the guided flow explicitly.

Use `back` to revisit a question or `edit <question-id>` for an answered
question. Change an explicit flag to edit its answer. `skip` leaves an optional
choice unanswered; `defer` prioritizes it on resume. `cancel` leaves the last
saved plan intact; answers since the last saved question block may be lost.
Run the interview again to continue. Existing settings are preserved unless
explicitly changed; `--force` starts the interview answers again.

The scope flag controls provider deployment: `project` targets project files;
`user` targets the provider's user configuration. Project policy and registry
writes still use their own owners. This is separate from globally installing
the CLI with npm, and from the direct deployment command's global mode.

## Review, then apply

```bash
aiwg setup --review
aiwg setup --apply
```

Review groups actions by workspace and provider and reports conflicts, stale
facts, and missing credential references without writing anything. With a
saved plan, a bare `aiwg setup --dry-run` is also a review. With interview flags,
`--dry-run` previews an interview without saving it. `--review --json` emits the
review report; `--apply --json` emits `aiwg.setup.apply.v1`. Use `--plan <id>`
on review/apply to select another saved plan, and `--target <dir>` to identify
the project that owns it.

Apply asks for confirmation, invokes the existing owners, and saves receipts
after each action. Usage intent chooses the framework: `code` and `mixed` use
SDLC, `docs` uses writing, and `ops` uses ops. Direct complete-system deployment
remains available through `aiwg use all --provider <provider>`.

The apply report distinguishes `success`, `partial` (core ready, optional
actions failed or skipped), and `failure` (core actions failed or skipped).
Partial and failed results return a nonzero exit code. Inspect the action
messages before claiming readiness. A successful repeat apply is a no-op;
partial and interrupted runs retry only unfinished actions. A crash between an
owner's external side effect and its saved receipt requires checking that owner
before retrying. Changed environment facts are refused: rerun discovery through
the interview and review the new plan rather than forcing stale actions.

## Headless answers use the same flow

```bash
aiwg setup --scope project --providers claude --intent code --jev decline --worker-dispatch decline --non-interactive --json
aiwg setup --review --json
aiwg setup --apply --yes --non-interactive --json
```

Headless mode never prompts. Required unanswered choices fail with the flag to
supply; optional integrations stay off when unanswered. Apply requires `--yes`
when no interactive confirmation is available. The example records a plan; a
provider configuration action without a credential reference can remain
skipped until you supply its reference and rerun the interview.

Credential flags store locators only. Supply the named environment variable
securely in the apply process, or use an absolute file reference or redirected
stdin. Do not paste a token into an argument or plan. For example:

```bash
aiwg setup --scope project --providers claude --credential claude=env:ANTHROPIC_API_KEY --non-interactive
```

`--credential claude=file:/absolute/path` references a file;
`--credential claude=stdin` defers input until apply. The interview and review
never resolve credential bytes.

## Multiple roots and monorepos

Discovery starts with the current workspace and registered roots. Additional
scanning requires explicit opt-in; it is bounded and refuses home/filesystem
roots. Use `--scan-roots <dir>` to observe another root and repeat
`--workspace <root>` to select observed roots. Selection of a monorepo root or
package must be explicit in headless mode:

```bash
aiwg setup --scope project --monorepo root --non-interactive
aiwg setup --scope project --monorepo package --package packages/app --non-interactive
```

The package must be an observed package root. Review project/user scope
conflicts and provider destinations before applying; a scope switch does not
authorize replacing existing files.

## Optional integrations

Jev sends decisions to an external service and requires an account/API access;
usage charges apply. Enable it explicitly with a reference:

```bash
aiwg setup --scope project --jev enable --credential jev=env:JEV_API_KEY --non-interactive
```

`--jev decline` leaves it off; `--jev defer` leaves the choice unresolved.
Existing Jev options include `--region <r>`, `--endpoint <https-url>`,
`--token-stdin`, `--verify`, and `--remove`. Verification can send a billable
request at apply; no network probe runs in the interview. Removal is explicit
and cannot be combined with enable options.

```bash
aiwg setup --scope project --worker-dispatch enable --non-interactive
```

Direct workers use their own accounts' quota. Installing a worker CLI does not
qualify it: apply delegates to worker setup and doctor qualification, and launch
checks availability again. Configure worker paths, groups, and limits through
the existing parallelism configuration. Worker qualification or Jev failures
are reported separately so core readiness remains visible. See
[worker dispatch](worker-dispatch.md) for account and qualification details.
