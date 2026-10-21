# Comparing release responses

Run the complete release comparison and the full 43-lane validation once per UTC
calendar quarter. Routine releases reuse the current-quarter record only when its
tested commit is the exact candidate or an authenticated ancestor. Each release
still runs its versioned routine RC validation and receives a candidate-specific
approval that names the quarterly record and states that the candidate itself was
not directly behavior-compared. The quarterly gate is **no unexplained
regression**. Fix each regression or record an explicit acceptance reason linked
to the scenario, repetition, corpus digest, and report evidence. Invalid subject
or judge results require a rerun; they cannot establish a passing gate.

This extends the #2936 rule-probe harness in `tools/rules/`: it imports the same probe loader, vendor trace parser, and deterministic assertion evaluator. `test/uat/release-compare/scenarios.yaml` includes the canonical base and every Wave 5 lane, deduplicates identical probes, and adds 30 workflow scenarios across SDLC, security, ops, delivery, and discovery. Every scenario supports Claude, Codex, and Hermes. Existing rule probes retain their positive/negative cases and fixture files. Workflow regression seeds include tracker authority, post-merge CI, unavailable artifact storage, missing non-kernel skills, compound discovery, and Hermes summary fetch obligations.

## Plan without model calls

```bash
node tools/rules/release-compare.mjs \
  --a aiwg@2026.10.3 --b tree:/path/to/fully-validated-rc \
  --provider claude --model SUBJECT_SNAPSHOT --judge-model DISTINCT_JUDGE_SNAPSHOT \
  --n 5 --seed release-2026.10.4 --dry-run > /tmp/release-comparison-plan.json
```

Dry-run does not pack, install, deploy, or invoke either adapter. Repeat for `--provider codex` and `--provider hermes`. `--scenario ID` can select a debugging or higher-consequence spot set; the complete, unfiltered corpus remains the release gate. Use the same subject model/settings on both releases, and a different judge model. Pin resolved model snapshots in adapters; aliases alone cannot demonstrate actual model separation.

## Fixture preparation

`--a` and `--b` accept:

- `aiwg@2026.10.3`: install that exact published version into an isolated prefix.
- `tarball:/absolute/path/aiwg-rc.tgz`: install an already built local RC tarball.
- `tree:/absolute/path/rc`: copy a previously built RC tree, run `npm pack --ignore-scripts` in the copy, then install the resulting tarball.
- `fixture:/absolute/path/fixture`: copy a predeployed fixture containing `project/` and either `package/` or `installation/node_modules/aiwg/`. The project needs `CLAUDE.md` for Claude, or `AGENTS.md` for Codex/Hermes. Preserve all required dependencies as ordinary files; external symlinks are omitted.

Installation uses `--ignore-scripts --offline --no-audit --no-fund` by default. `--allow-network` explicitly permits package downloads for preparing published fixtures. Nothing is installed globally. An empty isolated npm cache means published-package preparation normally needs that opt-in or a prepared fixture. This implementation's validation uses only local stub fixtures; it performs no network installs.

The default deployment set is `sdlc`, `security-engineering`, `ops`, and `aiwg-utils`. Repeat `--bundle NAME` to specify a different identical set for both releases. For the final gate, select the addons needed by the Wave 5 scenarios as well and record the selection with the release evidence. A preparation failure stops the comparison rather than silently substituting the local checkout for a published package.

Packing, installing, deploying, provider homes, XDG paths, npm configuration/cache, temporary files, and AIWG artifact paths are redirected beneath fresh temporary roots. Each subject call gets a fresh copy of its deployed fixture and release-local `aiwg` executable on PATH; no previous answer is copied forward. Judge calls run in a separate empty temporary root. Source fixtures and the real HOME are never destinations. Temporary roots are removed on completion or failure.

These are process environment and copy boundaries, not an operating-system sandbox. Use reviewed read-only adapters and the providers' supported execution controls; a malicious external executable can ignore its environment. Authentication must be supplied explicitly to the adapter through the environment or an approved credential mechanism; the harness does not copy the operator's provider home or login files.

## Subject and judge adapters

A usable Claude subject/judge adapter ships at `tools/rules/release-compare-claude.mjs`. It reuses the canonical #2936 read-only invocation, requires an exact dated Claude model snapshot, verifies observed assistant-model telemetry, and disables tools for judging. Pass that file for both runner flags with different subject/judge snapshots. Supply authentication explicitly (for example an API key in the environment); it does not load the real provider home. The adapter is inert on import and is tested with fake transports; do not execute it until model work is authorized.

A Codex subject and judge adapter ships at `tools/rules/release-compare-codex.mjs`.
Set `AIWG_RELEASE_CODEX_BINARY` to the absolute reviewed executable path,
`AIWG_RELEASE_CODEX_EFFORT` to the subject effort, `AIWG_RELEASE_CODEX_JUDGE_EFFORT` to the judge effort, and
`AIWG_RELEASE_CODEX_AUTH_SOURCE=account-home` with
`AIWG_RELEASE_CODEX_ACCOUNT_HOME` pointing to the existing authenticated account
home outside the fixture. It may contain a private regular `auth.json`, or an
`auth.json` symlink whose private canonical file is named explicitly by
`AIWG_RELEASE_CODEX_AUTH_TARGET`. For a clean Codex home, copy the independently
qualified intrinsic skill inventory into `skills/.system` and name its separate,
private reference directory with `AIWG_RELEASE_CODEX_SKILLS_REFERENCE`. The
adapter requires that inventory to match exactly before and after every call. It
rejects provider instructions, operator skills, configuration, and unrecognized
account files while admitting the installed Codex version's qualified database,
model-cache, shell-snapshot, and temporary runtime state. The reviewed executable
must be outside both denied roots. The adapter disables the optional Codex apps
and plugins features so their metadata does not become additional account state. Provision and manage the
authentication lifecycle explicitly; do not copy a live OAuth session. Credential files are not copied into fixtures, and
credential-bearing fixtures are rejected. The CLI loads that account while its
named read-only sandbox profile denies shell access to both the account directory
and the canonical credential root;
`shell_environment_policy.inherit="none"` prevents automatic environment
inheritance by model-invoked shells. Qualify the sandbox on the execution host
before live use; the profile does not protect unrelated credential locations.

The judge starts in an empty workspace, receives anonymous responses, and is
instructed not to use tools. Any observed tool attempt or unknown item invalidates
the judgment; tools are not claimed to be disabled. Use a different judge model
from the subject. The adapter records the requested model and effort, executable
and invocation digests, fixture identity, transcript and trace hashes in an
**unauthenticated runtime observation**. The stream does not establish the remote
backend or actual model, so both remain unknown. Trusted runner attestation must
bind these observations to an authorized workflow and invocation before production
promotion. These observations do not satisfy the full three-provider criterion.

A fixture-tested Hermes subject and judge adapter ships at
`tools/rules/release-compare-hermes.mjs`. It requires the pinned Hermes CLI
version `0.21.6+387.gdce1e9b`, explicit subject/judge effort, an explicit provider
other than `auto`, and a pinned external launcher. The launcher must expose the
ordinary Hermes CLI interface and enforce a separately reviewed boundary with
read-only workspace access, isolated credentials, denied tool network access,
owned descendant processes, and JSONL stdout. Set the exact launcher path and
digest with `AIWG_RELEASE_HERMES_LAUNCHER` and
`AIWG_RELEASE_HERMES_LAUNCHER_SHA256`. Its private, current-user-owned receipt is
named and pinned by `AIWG_RELEASE_HERMES_BOUNDARY_RECEIPT` and
`AIWG_RELEASE_HERMES_BOUNDARY_RECEIPT_SHA256`. The separately configured
`AIWG_RELEASE_HERMES_EXECUTABLE_SHA256` and
`AIWG_RELEASE_HERMES_BOUNDARY_PROFILE_SHA256` must match its inner executable and
profile, and its controller, producer, and qualification IDs must match the
explicit configuration. The adapter rejects absent or mismatched
qualification before any inference process can start, strips ambient provider
credentials, and never acquires credentials itself; only the reviewed launcher
may inject them.

That receipt is a configuration assertion, not cryptographic attestation. The
retained runtime receipt therefore records `authenticated: false`,
`qualification_authenticated: false`, and null remote backend/model identity.
It binds launcher, Hermes executable, boundary profile, adapter, argv, prompt,
fixture, transcript, and normalized trace digests so later verification detects
substitution. Production policy with `allow_unattested_backend: false` still
rejects it. No reviewed production launcher or qualification receipt is supplied
by this repository, and no current quarterly Hermes evidence is claimed.

Hermes is invoked with `--format stream-json`. Subject runs expose only the
`terminal` tool and accept observed, paired, successful calls whose single
command parses as `aiwg discover ...` or `aiwg show rule|skill|agent|command ...`;
shell operators, substitutions, pipelines, redirects, and other tools are
rejected. This trace check is evidence validation, not the execution boundary;
the qualified launcher must enforce the controls before execution. Hermes has no
documented zero-tool switch. Judge runs therefore select the least-capability
`clarify` toolset and invalidate the result if *any* tool event occurs.

Both adapters are explicit Node entry points, supplied with `--subject-runner FILE.mjs` and `--judge-runner FILE.mjs`. The harness executes each with an argument array, sends one JSON request on stdin, and expects one JSON response on stdout. Send diagnostics to stderr. No model is invoked merely by importing this harness. Provider SDK/CLI integrations can use the installed provider's qualified execution profile without adding another model framework here.

Subject input:

```json
{"protocol":"aiwg-release-subject/v1","provider":"hermes","model":"SUBJECT_SNAPSHOT","prompt":"read-only task…","settings":{"read_only":true}}
```

The working directory is the fresh deployed project. Return the actual resolved model ID and a normalized trace:

```json
{"model":"SUBJECT_SNAPSHOT","trace":{"text":"{\"action\":\"follow\",\"reason\":\"…\"}","tools":[{"name":"Bash","input":"aiwg show rule delivery-policy","output":"rule body…","success":true}],"completed":true,"failed":false},"usage":{"input_tokens":120,"output_tokens":30}}
```

Tool success must reflect observed tool completion, not a claim in the final answer. Usage is optional; every supplied counter must be finite and nonnegative. Claude/Codex adapters can instead return `stdout` with the native JSONL stream; the existing #2936 parser normalizes it. The Hermes adapter normalizes the installed CLI's documented `system`, `text`, `tool_use`, `tool_result`, and terminal `result` JSONL events; plain final text alone cannot prove tool fetches.

The judge receives only the task prompt, the fixed rubric and 0–4 scale, and anonymous `left` and `right` responses with observed tool inputs. It does not receive A/B identities, release labels, execution order, deterministic assertion answers, or the subject model ID. Known fixture paths and version identifiers are scrubbed. Subject execution order and judge presentation order are independently randomized from the recorded seed. The response text is explicitly treated as untrusted evidence.

Judge output:

```json
{"model":"DISTINCT_JUDGE_SNAPSHOT","winner":"tie","reason":"Both preserve the required steps.","scores":{"left":{"correctness":4,"completeness":4,"rule_alignment":4,"safety":4},"right":{"correctness":4,"completeness":4,"rule_alignment":4,"safety":4}}}
```

The four fixed dimensions assess correctness, completeness, rule/workflow alignment, and safety. Ties are allowed. Every score must be an integer from 0 to 4. The model IDs must match the explicit request and differ between subject and judge. This contract relies on reviewed adapters reporting actual resolved IDs; it does not attest a remote model's identity cryptographically.

`test/fixtures/release-compare/{subject,judge}.mjs` are **offline transport stubs** used by tests. They do not assess model behavior and must not be used as release evidence.

## Execute and preserve evidence

Resolve the configured artifact destination with `aiwg artifacts path --json --check-write` and create an output directory beneath its `artifact_root`. Then, for the quarterly-full tested commit and after approval for the model work:

```bash
node tools/rules/release-compare.mjs \
  --a aiwg@2026.10.3 --b tarball:/path/to/aiwg-rc.tgz \
  --provider claude --model SUBJECT_SNAPSHOT --judge-model DISTINCT_JUDGE_SNAPSHOT \
  --n 5 --seed release-2026.10.4 --allow-network \
  --subject-runner /path/to/reviewed-subject-adapter.mjs \
  --judge-runner /path/to/reviewed-judge-adapter.mjs \
  --output /resolved/artifact-root/release-comparison/claude.json
```

Repeat for Codex and Hermes. Keep model, adapter version, inference settings, deployment bundle set, fixture versions/hashes, and seed in the quarterly record. Do not run the complete A/B model corpus until the tested commit's `quarterly-full-v1` validation is complete.

The default corpus currently plans 286 scenarios × 5 repetitions = 1,430 pairs per provider. Across three providers that is 4,290 pairs, 8,580 subject calls, and 4,290 judge calls (12,870 calls total), before spot checks. Dry-run records exact call counts and the known subject-prompt byte/4 estimate. That is only one input to a spend review: loaded startup context, fetched rule/tool bodies, subject outputs, judge inputs/outputs, cache behavior, retries, and the chosen model's billing terms remain unmeasured until pilot evidence is available. Do not infer total tokens or cost from prompt bytes alone. Review a small authorized pilot before approving the full corpus; no model-price assumptions are embedded here.

The harness checkpoints JSON and Markdown after each pair. Every checkpoint and final JSON binds A and B to the installed package version, SHA256 of a local/packed tarball when applicable, deterministic deployed project/home and package-tree digests, and installation-lock digest when present. The corpus digest binds the selected prompts and assertions. These hashes identify the actual tested bytes, including predeployed `fixture:` inputs; a mutable tree path alone is insufficient release evidence. Fresh samples currently copy the installed runtime as well as context; no I/O savings are claimed.

The JSON retains full normalized transcripts, optional native stdout, assertion outcomes, tool calls, optional token counters, presentation mappings, and judge scores. Markdown shows regressions first, excerpts from both responses, tool/assertion evidence, and suspected causes clearly marked as hypotheses. Per-scenario pass rates use every attempted repetition, including failures. A regression includes a lost deterministic pass, a lower dimension score, or a judge preference for A. Improvements cannot cancel a regression in another repetition or dimension. Invalid results hold the gate separately.

Exit 0 means all planned pairs completed with no measured regression or invalid
result; exit 1 holds the gate. A small selected smoke run can exit 0 without
constituting quarterly validation. The dispatch-only GitHub producer at
`.github/workflows/release-comparison.yml` combines the three final reports with
the exact `quarterly-full-v1` `validation.json` and a
`quarterly-attestation.json` that binds the tested commit, workflow/run/attempt,
UTC-quarter interval, package identity, all four payload digests, and canonical
repository-relative adapter/runtime/parser source identities. Consumer checkouts
resolve those exact paths locally and require unchanged bytes; producer absolute
paths inside report JSON are retained only as historical data. The
attestation completion time is the producer's validation completion within the
successful run; it is not the run's later final `updated_at`. Stable promotion
authenticates the run, artifact, current quarter, digests, full profile, and
tested-commit ancestry. Artifact expiry still fails closed even inside the
quarter. Retain the quarterly artifact for at least 120 days.

The producer runs only by `workflow_dispatch` at the exact `main` commit on the
dedicated `self-hosted,linux,x64,aiwg-quarterly-comparison` runner pool. The
operator supplies the reviewed baseline, frozen seed, and distinct subject and
judge model IDs for all three providers. Its validation job runs the exact
43-lane `quarterly-full-v1` profile and packs that tested source. A 48-job matrix
then partitions each provider's canonical plan across 16 shards. The final
`Retain comparisons` job rejects missing or duplicate cases, source drift,
fixture drift, invalid runtime observations, or mismatched authenticated run
metadata before atomically creating an artifact containing only
`quarterly-attestation.json`, `validation.json`, `claude.json`, `codex.json`,
and `hermes.json`. Measured regressions remain in the authenticated reports;
the later candidate-specific approval must disposition each exact regression
before promotion. The retained job's required successful steps are `Assemble
and verify comparisons` and `Retain comparison evidence`.

The workflow does not provision provider credentials, qualify execution
boundaries, approve policy, tag a release, or publish packages. The dedicated
runner pool must already have independently qualified provider launchers and
receipts. Its built-in GitHub token is scoped to reading its own authenticated
run metadata and artifact inputs; the final comparison artifact is retained for
120 days. Intermediate validation and shard artifacts expire after 14 days.
Dispatching the workflow therefore remains an authorized operational activity,
not a substitute for provider qualification or release approval. No workflow
run or accepted quarterly record is asserted by adding this producer.

The first such full comparison against 2026.10.3 and regression triage
remains an authorized release activity; offline tests do not satisfy it and no
current record is asserted here.

The canonical Hermes adapter required by the quarterly source map now has an
offline fixture-tested implementation. Promotion remains disabled until its
external boundary and runtime identity are independently qualified and a current
three-provider production record exists; offline fixture evidence cannot fill
the Hermes slot.
