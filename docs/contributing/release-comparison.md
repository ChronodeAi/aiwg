# Comparing release responses

Run release comparison after the RC build and full validation, before shipping. The gate is **no unexplained regression**. Fix each regression or record an explicit acceptance reason in the release issue, linked to the scenario, repetition, corpus digest, and report evidence. Invalid subject or judge results require a rerun; they cannot establish a passing gate.

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

Both adapters are explicit Node entry points, supplied with `--subject-runner FILE.mjs` and `--judge-runner FILE.mjs`. The harness executes each with an argument array, sends one JSON request on stdin, and expects one JSON response on stdout. Send diagnostics to stderr. No model is invoked merely by importing this harness. Provider SDK/CLI integrations can use the installed provider's qualified execution profile without adding another model framework here.

Subject input:

```json
{"protocol":"aiwg-release-subject/v1","provider":"hermes","model":"SUBJECT_SNAPSHOT","prompt":"read-only task…","settings":{"read_only":true}}
```

The working directory is the fresh deployed project. Return the actual resolved model ID and a normalized trace:

```json
{"model":"SUBJECT_SNAPSHOT","trace":{"text":"{\"action\":\"follow\",\"reason\":\"…\"}","tools":[{"name":"Bash","input":"aiwg show rule delivery-policy","output":"rule body…","success":true}],"completed":true,"failed":false},"usage":{"input_tokens":120,"output_tokens":30}}
```

Tool success must reflect observed tool completion, not a claim in the final answer. Usage is optional; every supplied counter must be finite and nonnegative. Claude/Codex adapters can instead return `stdout` with the native JSONL stream; the existing #2936 parser normalizes it. Hermes adapters must normalize observed tool events and authoritative completion using the qualified Hermes integration; plain final text alone cannot prove tool fetches. No fictional Hermes JSONL format is assumed.

The judge receives only the task prompt, the fixed rubric and 0–4 scale, and anonymous `left` and `right` responses with observed tool inputs. It does not receive A/B identities, release labels, execution order, deterministic assertion answers, or the subject model ID. Known fixture paths and version identifiers are scrubbed. Subject execution order and judge presentation order are independently randomized from the recorded seed. The response text is explicitly treated as untrusted evidence.

Judge output:

```json
{"model":"DISTINCT_JUDGE_SNAPSHOT","winner":"tie","reason":"Both preserve the required steps.","scores":{"left":{"correctness":4,"completeness":4,"rule_alignment":4,"safety":4},"right":{"correctness":4,"completeness":4,"rule_alignment":4,"safety":4}}}
```

The four fixed dimensions assess correctness, completeness, rule/workflow alignment, and safety. Ties are allowed. Every score must be an integer from 0 to 4. The model IDs must match the explicit request and differ between subject and judge. This contract relies on reviewed adapters reporting actual resolved IDs; it does not attest a remote model's identity cryptographically.

`test/fixtures/release-compare/{subject,judge}.mjs` are **offline transport stubs** used by tests. They do not assess model behavior and must not be used as release evidence.

## Execute and preserve evidence

Resolve the configured artifact destination with `aiwg artifacts path --json --check-write` and create an output directory beneath its `artifact_root`. Then, after RC full validation and approval for the model work:

```bash
node tools/rules/release-compare.mjs \
  --a aiwg@2026.10.3 --b tarball:/path/to/aiwg-rc.tgz \
  --provider claude --model SUBJECT_SNAPSHOT --judge-model DISTINCT_JUDGE_SNAPSHOT \
  --n 5 --seed release-2026.10.4 --allow-network \
  --subject-runner /path/to/reviewed-subject-adapter.mjs \
  --judge-runner /path/to/reviewed-judge-adapter.mjs \
  --output /resolved/artifact-root/release-comparison/claude.json
```

Repeat for Codex and Hermes. Keep model, adapter version, inference settings, deployment bundle set, fixture versions/hashes, and seed in the release record. Do not run the complete A/B model corpus until the RC is complete.

The default corpus currently plans 286 scenarios × 5 repetitions = 1,430 pairs per provider. Across three providers that is 4,290 pairs, 8,580 subject calls, and 4,290 judge calls (12,870 calls total), before spot checks. Dry-run records exact call counts and the known subject-prompt byte/4 estimate. That is only one input to a spend review: loaded startup context, fetched rule/tool bodies, subject outputs, judge inputs/outputs, cache behavior, retries, and the chosen model's billing terms remain unmeasured until pilot evidence is available. Do not infer total tokens or cost from prompt bytes alone. Review a small authorized pilot before approving the full corpus; no model-price assumptions are embedded here.

The harness checkpoints JSON and Markdown after each pair. Every checkpoint and final JSON binds A and B to the installed package version, SHA256 of a local/packed tarball when applicable, deterministic deployed project/home and package-tree digests, and installation-lock digest when present. The corpus digest binds the selected prompts and assertions. These hashes identify the actual tested bytes, including predeployed `fixture:` inputs; a mutable tree path alone is insufficient release evidence. Fresh samples currently copy the installed runtime as well as context; no I/O savings are claimed.

The JSON retains full normalized transcripts, optional native stdout, assertion outcomes, tool calls, optional token counters, presentation mappings, and judge scores. Markdown shows regressions first, excerpts from both responses, tool/assertion evidence, and suspected causes clearly marked as hypotheses. Per-scenario pass rates use every attempted repetition, including failures. A regression includes a lost deterministic pass, a lower dimension score, or a judge preference for A. Improvements cannot cancel a regression in another repetition or dimension. Invalid results hold the gate separately.

Exit 0 means all planned pairs completed with no measured regression or invalid result; exit 1 holds the gate. A small selected smoke run can exit 0 without constituting full release validation. The first full comparison against 2026.10.3 and regression triage remains a release activity after RC readiness; offline tests do not satisfy it.
