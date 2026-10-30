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

Installation uses `--ignore-scripts --offline --no-audit --no-fund` by default. To prepare `aiwg@2026.10.3` offline, pass `--npm-cache /path/to/populated/npm-cache`: only its `_cacache/` is copied into each isolated cache, leaving the source untouched. That cache must contain the version metadata, package and dependencies needed by npm. Alternatively supply the published package as `tarball:/path/to/aiwg-2026.10.3.tgz`. Dependencies must also be cached unless the package has none. A cache miss fails without a network fallback. `--allow-network` explicitly permits package downloads. Nothing is installed globally. Tests pack and install dependency-free synthetic packages with real npm, including an RC tree, and compare them with deterministic fake runners; no network or model calls are involved.

The default deployment set is `sdlc`, `security-engineering`, `ops`, and `aiwg-utils`. Repeat `--bundle NAME` to specify a different identical set for both releases. For the final gate, select the addons needed by the Wave 5 scenarios as well and record the selection with the release evidence. A preparation failure stops the comparison rather than silently substituting the local checkout for a published package.

Both packages deploy onto the same `test/fixtures/rule-binding/project/` template. `--fixture-project DIR` selects another synthetic project for both sides. Predeployed `fixture:` inputs retain their already deployed projects and homes. Every subject repetition still receives a fresh temporary copy.

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

### OpenRouter transport and spend cap

Set `AIWG_RELEASE_CLAUDE_TRANSPORT=openrouter` and supply `OPENROUTER_API_KEY`
through the environment only. Do not put a key in a command, price file, or
report. The adapter passes the key only as `ANTHROPIC_AUTH_TOKEN`, sets
`ANTHROPIC_BASE_URL=https://openrouter.ai/api` and `ANTHROPIC_API_KEY=` (empty),
and filters other credentials from the CLI environment. Router pins are
`anthropic/claude-haiku-5.5` and `anthropic/claude-sonnet-5.5`; observed telemetry
must match, allowing the stream to omit `anthropic/`. The default transport
continues to require an exact dated Anthropic snapshot.

Use `--max-usd X --max-calls N --price-file FILE.json`. A capped run requires
prices for both models, including a subscription entry for a Codex judge.
The price file is a JSON object keyed by the exact requested model IDs. Each paid
entry requires `source` (pricing URL and retrieval date), numeric
`input_usd_per_mtok`, `output_usd_per_mtok`, `max_input_tokens`, and
`max_output_tokens`. Optional `cache_read_usd_per_mtok` and
`cache_write_usd_per_mtok` account for Claude's separate cache counters; absent
cache rates use the input rate. Set the token allowances conservatively for
the **entire adapter invocation**, including startup context, tool turns and
retries. They are budget reservations, not token limits enforced on a provider.
Use current, sourced OpenRouter rates; Claude's `total_cost_usd` uses Anthropic
list prices and is ignored for router billing. No prices are fetched automatically.
For a qualified Codex account judge, use
`{"subscription":true,"source":"ChatGPT subscription; no USD charge"}` as its
price entry and select `tools/rules/release-compare-codex.mjs` with an explicit
distinct Codex model and the account configuration described above.

The runner reserves two subject calls and one judge call before each pair. It
stops before projected spend exceeds **80%** of the USD cap, or the next pair
would exceed the call cap. Reported costs accumulate per call; missing cost is
computed from usage and prices, and missing token counters reserve their full
allowances. Failed calls consume a reservation. A spend surprise also stops
subsequent calls within the pair. JSON and Markdown checkpoints record the cap,
spend, per-call accounting, and `stop_reason`; a stopped comparison exits 1 and
cannot pass. These checks govern starting calls: they cannot bound an already
running provider request. An invoice-level hard limit also requires an
OpenRouter account/key spending limit; do not treat token reservations as that
provider limit.

For the USD 10 operator allocation, the following commands split the budget:
at most USD 2 for the pilot and USD 8 for the full Claude run. The 80% stop rule
leaves additional headroom. Do not reset or repeat these allocations after spend
without subtracting previous charges. Supply the reviewed RC tarball and sourced
price file at the indicated paths. These are live commands; the offline tests
do not execute them. Hermes is excluded until a qualified launcher exists.

```bash
export AIWG_RELEASE_CLAUDE_TRANSPORT=openrouter
comparison_rc=/absolute/path/to/aiwg-rc.tgz
comparison_prices=/absolute/path/to/openrouter-prices.json
comparison_artifact_root=$(aiwg artifacts path --json --check-write | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).artifact_root))')
mkdir -p "$comparison_artifact_root/release-comparison"

# Pilot: three scenarios, one repetition, nine adapter calls maximum.
node tools/rules/release-compare.mjs \
  --a aiwg@2026.10.6 --b "tarball:$comparison_rc" --allow-network \
  --provider claude --model anthropic/claude-haiku-5.5 \
  --judge-model anthropic/claude-sonnet-5.5 --n 1 --seed release-3298-pilot \
  --scenario sdlc-small-change --scenario sdlc-intake-unknown \
  --scenario discovery-discover-show-follow --bundle all \
  --max-usd 2 --max-calls 9 --price-file "$comparison_prices" \
  --subject-runner tools/rules/release-compare-claude.mjs \
  --judge-runner tools/rules/release-compare-claude.mjs \
  --output "$comparison_artifact_root/release-comparison/claude-openrouter-pilot.json"

# Full Claude corpus: run after reviewing the pilot and quarterly validation.
node tools/rules/release-compare.mjs \
  --a aiwg@2026.10.6 --b "tarball:$comparison_rc" --allow-network \
  --provider claude --model anthropic/claude-haiku-5.5 \
  --judge-model anthropic/claude-sonnet-5.5 --n 5 --seed release-3298-full \
  --bundle all --max-usd 8 --max-calls 4290 --price-file "$comparison_prices" \
  --subject-runner tools/rules/release-compare-claude.mjs \
  --judge-runner tools/rules/release-compare-claude.mjs \
  --output "$comparison_artifact_root/release-comparison/claude-openrouter-full.json"
```

Append `--dry-run` to inspect either plan without installation or model calls.
The full command retains a HOLD if its allocated budget cannot cover the corpus;
the USD cap does not authorize dropping scenarios or counting a pilot as a gate.

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

Resolve the configured artifact destination with `aiwg artifacts path --json --check-write` and create an output directory beneath its `artifact_root`. The runner enforces this destination for JSON and Markdown, including symlink targets. Then, for the quarterly-full tested commit and after approval for the model work:

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

For a first real Claude breadth run from a built checkout, this exact command uses
the shipped adapter and distinct dated model snapshots. It prepares the baseline
from npm and packs the current tree; it performs paid model calls. The selected
deployment set includes every framework/addon under test. Run it only after the
validation and model-work approval above:

```bash
comparison_artifact_root=$(aiwg artifacts path --json --check-write | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).artifact_root))')
mkdir -p "$comparison_artifact_root/release-comparison"
node tools/rules/release-compare.mjs \
  --a aiwg@2026.10.3 --b tree:. --allow-network \
  --provider claude --model claude-haiku-4-5-20251001 \
  --judge-model claude-sonnet-4-5-20250929 --n 5 --seed release-first-breadth \
  --bundle all \
  --subject-runner tools/rules/release-compare-claude.mjs \
  --judge-runner tools/rules/release-compare-claude.mjs \
  --output "$comparison_artifact_root/release-comparison/claude.json"
```

For offline fixture preparation, replace `--allow-network` with
`--npm-cache /path/to/populated/npm-cache`, or supply local tarballs for both
sides and the cache needed for their dependencies. Dry-run the same command
with `--dry-run` to obtain the exact planned call count without installation or
model calls. This single-provider breadth run plans 2,860 subject calls plus
1,430 judge calls, 4,290 total; provider-internal tool turns and retries can add
inference requests beyond the harness invocation count.

The default corpus currently plans 286 scenarios × 5 repetitions = 1,430 pairs per provider. Across three providers that is 4,290 pairs, 8,580 subject calls, and 4,290 judge calls (12,870 calls total), before spot checks. Dry-run records exact call counts and the known subject-prompt byte/4 estimate. That is only one input to a spend review: loaded startup context, fetched rule/tool bodies, subject outputs, judge inputs/outputs, cache behavior, retries, and the chosen model's billing terms remain unmeasured until pilot evidence is available. Do not infer total tokens or cost from prompt bytes alone. Review a small authorized pilot before approving the full corpus; no model-price assumptions are embedded here.

The harness checkpoints JSON and Markdown after each pair. Every checkpoint and final JSON binds A and B to the installed package version, SHA256 of a local/packed tarball when applicable, deterministic deployed project/home and package-tree digests, and installation-lock digest when present. The corpus digest binds the selected prompts and assertions. These hashes identify the actual tested bytes, including predeployed `fixture:` inputs; a mutable tree path alone is insufficient release evidence. Fresh samples currently copy the installed runtime as well as context; no I/O savings are claimed.

The JSON retains full normalized transcripts, optional native stdout, assertion outcomes, tool calls, optional token counters, presentation mappings, and judge scores. Markdown shows regressions first, excerpts from both responses, tool/assertion evidence, and suspected causes clearly marked as hypotheses. Per-scenario pass rates use every attempted repetition, including failures.

Each scenario also records `structural_diff`: B-minus-A tool/discovery call
counts, added/removed fetched rules and skills, and token-counter deltas.
`A.usage_totals` and `B.usage_totals` sum counters across repetitions; a counter
missing from any repetition is unavailable, and a delta missing either side is
`null`, never an assumed zero. Structural differences support diagnosis and do
not independently classify a regression.

Classification first treats any A-passed/B-failed pair or lower B assertion pass
rate as a hard regression. Judge preferences use a one-sided exact binomial sign
test: with `a` baseline wins and `b` candidate wins, regression requires
`P(X >= a | X ~ Binomial(a+b, 0.5)) < alpha`. Ties are neutral and excluded from
the test. Alpha defaults to `0.05` (`--judge-alpha`, programmatic option
`judgeAlpha`, strictly between 0 and 1). At n=5, only 5/0 A wins count as judge
regression (`p=0.03125`); 4/1 has `p=0.1875`, and 1/3/1 is unchanged absent
other signals. With no non-tie wins, the p-value is 1.

A judge dimension regresses only when its B mean is below its A mean by
**more than** `--judge-score-margin` (programmatic option `judgeScoreMargin`).
The default is `1.0`, one point on the integer 0–4 judge scale; allowed margins
are 0 through 4. All judged pairs, including ties, contribute to these means.
The same assertion, sign-test, and dimension tests are mirrored for improvement.
When both directions trigger, regression wins; otherwise the result is unchanged.
Invalid evidence holds the gate, and incomplete comparisons cannot pass.

Plans and reports record `judge_alpha` and `judge_score_margin`. Select thresholds
before running and preserve them with the evidence; verification compares them
against the trusted plan, and the quarterly producer uses the defaults. Both
report formats show each scenario's A/B/tie tally, p-values for A and B,
dimension mean deltas (B minus A), maximum absolute dimension delta, decision
rule, and all triggered rules. Per-pair winners and scores remain in JSON;
Markdown also prints each pair's dimension deltas. See the
[tool README](../../tools/rules/README.md) for the concise rule.

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
