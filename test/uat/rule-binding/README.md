# Rule binding Phase 0 harness

These scripts observe current deployment and read-only behavioral decisions.
They do not change rule selection, activation, budgets, or discovery. The 20
epic-table rules overlap five of the six budget-demoted rules; adding
`anti-laziness` gave **21 rules, 63 probes, 315 calls at n=5** in Phase 0.
The current base adds a discovery shortcut control: **64 probes, 320 calls at n=5**.

## U1: startup bytes

Build the local CLI, then run from the repository root:

```bash
npm run build:cli
node tools/rules/measure-startup-context.mjs --check-po --existing-project . --output /tmp/measurement.json
```

Every provider runs the existing `aiwg use sdlc --provider <name>` owner in a
fresh temporary project and HOME. XDG and global provider directories are
isolated; operator configuration and budget overrides are excluded. Temp trees
are removed even on failure. `--fixture DIR` supplies a different project;
fixtures must be local, self-contained, and have no symlinks or external artifact
routing. The committed fixture is an empty application project.

`rules` counts emitted native rule surfaces, including indexes. `behaviors`
includes Claude's recursively loaded `.claude/rules/behaviors/*.md` files.
`startup` is their inclusive total. Claude path-scoped rule files are included
conservatively, matching the PO's directory-byte measurement. Cursor rules with
`alwaysApply: false` are `conditional`; its `.md` behavior mirrors are not MDC
startup rules. Codex mirrors are reported separately from startup rule bodies.
Warp measures its `WARP.md` rule section; Hermes measures its compressed
CRITICAL-rules section if still present after final context generation.
OpenClaw measures its provider rule directory under the isolated HOME; native
behavior payloads are reported as mirrors rather than always-loaded rules.
This observes deployer surfaces, not a vendor token-usage API.

`context_files` reports the context adapters separately; do not add it to
`startup` because aggregated providers can overlap. Token counts are explicitly
estimates: sum of `ceil(UTF-8 file bytes / 4)`, matching the deployer's budget
heuristic. They are not model tokenizer results. Per-file bytes are retained
for audit and later wave comparisons.

The committed [measurement baseline](measurement-baseline.json) reproduces the
PO's **207,444 rule bytes** exactly. Its behavior figure is **33,315 bytes**
against the PO's 33,411 (0.29% difference); behavior renderings include a
source path relative to the deploy process, so checkout/path lengths affect
these bytes. Inclusive Claude startup is **240,759 bytes**. The same six rules
appear in the budget sidecar. This worktree has no existing `.claude/rules`
directory: `existing_project.available` is false, so the historical repo-local
155,740-byte deployment cannot be remeasured from the available files. The
fresh deployment above is the current reproducible source baseline.
`repository_redeployment` additionally records a fresh isolated deploy of this
worktree's root context and package metadata (the exact copied files are listed
in `fixture_files`). It measures the same **207,444 + 33,315 = 240,759 bytes**.
There is no repository-local AIWG config or project bundle in this worktree to
change that selection. This is a fresh redeployment, not a reading of the
historical ignored provider directory.

Warp currently fails the existing model-wrapper verification after emitting
its rule section. The baseline records its emitted bytes and failed deployment;
the measurement exits 1 rather than certifying an incomplete deployment. Other
providers and both PO comparisons are still measured. No production workaround
is applied by this harness.

For later waves, enforce both a Claude ceiling (including behaviors) and no
provider growth:

```bash
node tools/rules/measure-startup-context.mjs --baseline test/uat/rule-binding/measurement-baseline.json --max-claude-bytes 110000 --output /tmp/wave-measurement.json
```

Exit 0 requires successful deployments and all requested byte gates. Missing
providers fail comparison. Use repeated `--provider NAME` to restrict collection;
a full-baseline comparison still requires all baseline providers.

## U5/U7: behavioral decisions and rule retrieval

Planning requires no provider binary, authentication, network, or model calls:

```bash
node tools/rules/run-rule-probes.mjs --dry-run --provider claude --model haiku --output /tmp/probe-plan.json
node tools/rules/run-rule-probes.mjs --dry-run --provider codex --model gpt-5.6-luna --rule quiet-mode
node tools/rules/run-rule-probes.mjs --dry-run --probes test/uat/rule-binding/wave5-secops-probes.yaml --rule evidence-integrity
```

Dry-run validates the JSON schema, coverage, assertion types/regexes, source
paths, and fixture paths, then prints every prompt, argument vector, repetition,
assertion, and total call count. It never calls `claude` or `codex`.

Wave 5 lane files declare `extends: probes.yaml`. The runner merges them with
the repository's canonical base by rule ID; a lane entry replaces the matching
base entry. Each input is schema-validated, then the merged suite is validated
for full base coverage. Lanes may contain fewer than 21 rules; standalone
catalogs still require at least 21. Use repeated `--rule` options to select lane
rules; without them the plan includes the full merged suite.

The [Wave 5 probe review](wave5-probe-review.json) records classification,
historical response evidence, binding metadata and proposed operator decisions.
Its unsafe-shortcut controls use `positive-3`: they exercise in-scope U5 behavior.
Existing out-of-scope `negative-1` controls still check U7 retrieval avoidance.
Probe changes require fresh runs and a matching probe digest before baseline
comparison; offline validation does not requalify the model compliance gate.

**The conductor runs the following paid commands**, once per provider/model
baseline. Prepare an expendable deployed fixture using the current checkout's
normal deploy command. The project must contain the provider's actual context
files and rule/skill surfaces; do not pass the source checkout itself.
The output must be outside that project so previous answers cannot enter a
later sample's context.

```bash
node tools/rules/run-rule-probes.mjs --project /tmp/deployed-fixture --aiwg-root /tmp/baseline/installation/node_modules/aiwg --provider codex --model gpt-5.6-luna --effort medium --codex-auth-target /private/codex/auth.json --codex-skills-reference /private/codex-system-skills --print-identity > /tmp/baseline-identity.json
node tools/rules/run-rule-probes.mjs --project /tmp/deployed-wave-fixture --aiwg-root /tmp/rc/installation/node_modules/aiwg --provider codex --model gpt-5.6-luna --effort medium --codex-auth-target /private/codex/auth.json --codex-skills-reference /private/codex-system-skills --require-compound-checks --print-identity > /tmp/rc-identity.json
```

The runner uses `claude -p` JSONL or `codex exec --json`, starts a new session
and fresh project copy for every sample, and checkpoints raw stdout/stderr,
exit codes, assertion results, and fetch evidence after every call. Existing
provider authentication remains available through the conductor's environment;
project copies omit `.git`, dependencies, build output, and symlinks. Discovery
uses an identity-verified copy of the selected locked npm installation inside each sample root and a
per-sample PATH shim. The installation identity binds the AIWG package, its hoisted dependency
graph, and `package-lock.json`; `--aiwg-root` must name `installation/node_modules/aiwg`. HOME, XDG
and temporary locations are isolated. The shared Codex transport uses a separately supplied existing
account directory, restricts the model's filesystem access to that account and excludes credentials
from its shell environment. No credentials are copied. Live calls require `--identity-file`,
`--account-home` and `--codex-executable` with absolute paths. Pass `--codex-auth-target` when the
private account uses an `auth.json` symlink and `--codex-skills-reference` when it contains
qualified intrinsic skills; these explicit runtime-only paths are not added to the model shell
environment. A candidate comparison also requires `--baseline` and `--baseline-identity-file`.
Review the generated identities before supplying them. The runner validates them against the actual
installation, fixture and configuration; it recomputes baseline rates from raw traces. The baseline
and candidate must use the same `--require-compound-checks` setting. Each raw run records its
controlled shim, package CLI and Node paths so replay accepts only that sample’s commands; foreign
absolute commands are not evidence. CLI calls are bounded. No automatic retries
hide failures. Defaults are Haiku for Claude and `gpt-5.6-luna` for Codex;
`--model` overrides either. `--n` below five is exploratory and cannot pass gates.

Positive probes check structured decisions; selected cases additionally require
successful reads/discovery in tool traces. They test policy decisions without
executing destructive actions, tracker writes, external decision requests,
compaction, or subagent dispatch. They complement the later waves' deployment
and live-dispatch gates; they do not prove those operations executed.

A fetch is inferred from a successful rule-show or rule-file read with returned
content, or an observed rule-body fingerprint in a tool result (including bound
skill/agent expansion). Source fingerprints and assertion answers are never
sent to the model. Final-answer mentions, index reads, discovery matches, and
summary pointers alone are not fetches. `attempted`, `fetched`, and `unknown`
are recorded separately. Negative probes fail conservatively on rule-read
attempts, including failed or unobserved results. Provider trace formats must
contain successful terminal events; malformed traces, timeouts, and CLI errors
remain failed samples in the denominator.

U5 requires every positive probe at least 80% compliant and each rule's pooled
positive compliance at least its baseline. U7 requires each negative probe to
avoid rule retrieval in at least 4/5 runs (and answer correctly). Baselines must
match the provider, model, effort, and probe digest, with at least five prior samples
for every selected probe. `--rule NAME` can select moved rules for a wave.
Incomplete runs cannot pass. The exit code is nonzero on a failed gate. No
compliance baseline is fabricated or committed by Phase 0; the conductor saves
and reviews the resulting report.

The `compound-discovery-probes.yaml` overlay adds read-only capability inspection
cases for three previously bound rules. Each observes the JSON discovery result,
the selected skill or agent show operation, and every successful rule fetch before
that operation. For a legacy or unbound result without a checklist, the report
records `legacy-or-unbound` rather than inventing a fetch requirement. Use
`--require-compound-checks` for the RC to make such a result fail the sample;
the baseline may lack that feature. A malformed trace, missing action, unmatched
discovery row, failed fetch, or uncertain ordering fails. These observations do
not establish that an actual workflow was executed or that all bound rules were
covered. Compare reports only with identical provider, model, effort, and probe digest.

## Offline tests

```bash
nice -n 19 ./node_modules/.bin/vitest run --config config/vitest.config.js --maxWorkers=4 test/unit/rules/startup-context.test.mjs test/unit/rules/rule-probes.test.mjs test/unit/providers/rule-tier-deployment.test.ts test/unit/providers/rule-trigger-stripping.test.mjs test/unit/consolidated-rules.test.ts
```

These exercise the existing provider writers with small fixtures, schema
negative controls, both CLI dry-runs with an empty PATH, vendor JSONL fixtures,
an injected fake transport, cleanup, and gate failures. They never run a vendor
model executable.

For live Codex probes, the controller initializes each isolated sample CLI with a bounded
`discover bootstrap --json` call before evaluation. It verifies that registration exists
and that the project and installed package are unchanged; bootstrap results are recorded
separately from scored model tool calls. A bootstrap failure prevents evaluation, remains
in the raw records, and leaves the plan incomplete without entering scoring denominators.

The prospective `common-target-discovery-probes.yaml` overlay focuses on capabilities
available in both the published baseline and candidate: Ralph for bounded loops and the
Jev decision skills. The quiet-mode compound case is held because the published baseline
exposes quiet-chat behavior rather than the candidate's fleet agents. Existing compound
results remain separate. Legacy discovery without required-rule metadata remains an
incomplete strict check; it must not be treated as a strict pass.

The prospective governed-migration lane distinguishes inspecting a skill from its
actual documented dry-run action. It evaluates required checks against the start of
the first migration preview, verifies the bounded result, and records fixture and
installation integrity. Earlier inspection-proxy results remain separate.
The earlier compound and common-target lanes require fetches before inspection, a
stronger surrogate than checking before governed work. Governed migration instead
uses the actual preview invocation as its boundary. An n=1 smoke is exploratory and
does not establish full U5 qualification.

A selected CLI's JSON rule or behavior show may satisfy a required check by name
only when the name aligns with that discovered checklist entry and the complete
JSON response binds the same canonical ID, type, name, and nonempty content.
Plaintext names do not provide that identity binding. Earlier raw results remain
unchanged; this support applies to prospective evaluations.
