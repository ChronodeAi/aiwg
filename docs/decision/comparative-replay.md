# Offline comparative policy replay

Status: **experimental, default-off, policy replay only** (#2616 comparative
AC13). The retained synthetic comparison is **HOLD**, with two known diagnostic
errors and unverified integrity. No provider calls, tokens, API spend, human
assessments, live qualification or production rollout occurred.

## Implemented scope

`buildComparativeReplayReport()` extends the #2037/#2048 serialization with the
unchanged upstream integrity envelope, its separately supplied trusted digest,
frozen membership/gold/plan bindings, all 600 diagnostic report digests,
root-level correctness, CI bounds, slice gates and an additive release verdict.
It uses the D23 analyzer and shared qualification Newcombe/Wilson helpers.
Upstream HOLD/ROLLBACK cannot become PROMOTE. Compromise becomes ROLLBACK.
Malformed or digest-mismatched artifacts are rejected before scoring.

The builder checks every report's source and plan pin, inference kind, zero row
and total resource consumption, hashed-value privacy and exact reproduction.
It validates all splits but counts only the 400 test roots in statistical N.
Multiple roots cannot reuse a source-result digest. Each frozen root has one
variant; variant count never becomes sample count. This v1 comparator is scoped
to this one-variant design, although D23 plans permit up to four variants.

The frozen corpus has 100 tuning roots, 100 validation roots (named
`calibration` solely for membership compatibility), and 400 test roots. Each
split is balanced over threshold boundaries, priority/loss outcomes, unchanged
controls and unreplayable fallback/producing-target cases. It uses new fictional
values, a seeded SHA-256 counter with rejection sampling, unique source inputs,
and an independently authored nine-operation reference table. It imports no
existing test fixtures and creates no live receipts. Loss values are deterministic
rule outcomes, not a fitted loss model or measured economic benefit.

The source generator and all assets have digests. `corpusDigest` in the
preregistration hashes the ordered `{id,payloadDigest}` inventory; `splitDigest`
hashes ordered members including source/plan pins; `goldDigest` hashes ordered
`{id,gold}` rows. The freeze manifest additionally hashes full asset envelopes.
The runner checks closed schemas and exact regeneration before replay.

## Retained result and limitations

The [retained report](evidence/comparative-replay-v1/report.json) records:

| Measure | Observed | Required |
| --- | --- | --- |
| Test roots | 400, 100 per slice | At least 400, 100 per slice |
| Exact diagnostic errors | 2 | Zero |
| False no-change claims on unreplayable roots | 0 | Zero |
| Newcombe-10 lower bound, 95% | −181 bps | At least −100 bps |
| Overall Wilson error upper, 95% | 181 bps | At most 100 bps |
| Threshold slice Wilson upper | 701 bps | At most 500 bps, zero known errors |
| Other three slice Wilson uppers | 370 bps each | At most 500 bps, zero known errors |
| Replay calls / tokens / API cost | 0 / 0 / 0 | Exactly zero |
| Reproduction | All 600 report digests identical across two passes | Exact |

`d23-test-threshold-boundary-041` and `-083` disagree with independently fixed
equality gold. The existing confidence acceptance comparison multiplies a
floating-point confidence by 10,000; equality can round below the integer
threshold. Gold remains unchanged, and the comparator reports failure. Fixing
that acceptance behavior is outside this comparative wrapper change.

This is a frozen **synthetic regression corpus**, not a procedurally pristine
held-out study: implementation inspected the test results. The local freeze and
access timestamps are genuine artifact-write events, but cannot retrospectively
establish operator preregistration. Request/authorization timestamps use a
labelled fixture clock. All model identities and attempt lineages are synthetic;
no model calibration is claimed. Template reuse limits population independence
and transfer beyond these authored source scenarios.

`diagnosticDecision` separates mechanical gate results from `decision`. Human
review ingestion is intentionally unavailable in v1: `reviewStatus` is always
`pending`, and even perfect diagnostics with upstream PROMOTE remain HOLD.
The real runner emits `standard`, `unverified`, `local-unverified` integrity.
Host callers must source trusted digests from independently protected records;
self-hashing a fabricated envelope does not establish trustworthy evaluation.
No causal, reviewer-time, model-quality or positive-economics claim follows.
USD 3 contingency remains unspent and authorizes no live experiment.

## Run offline

From a source checkout with existing dependencies:

```bash
nice -n 19 node --import tsx tools/decision/comparative-replay.ts
nice -n 19 node --import tsx tools/decision/comparative-replay.ts --replay
```

The first command is disabled and writes nothing. The explicit replay resolves
`aiwg artifacts path --json --check-write` and writes beneath
`<artifact_root>/decisions/sensitivity/d23-comparative-replay-v1/`. It has no
provider transport or reevaluation callback. The host identity stays fixed;
one shared probe state has capacity for 600 subjects and two reports/probes per
subject/path. A flushed reservation journal precedes each local replay. Completed
reports are written individually. A persistent exclusive study lock prevents
cross-restart budget reset, including after interruption; no automatic resume
or lock deletion is provided. Production durable anti-probing remains separate.
Cancellation stops before the next root while preserving completed reports.

The run directory contains `preregistration.json`, `freeze-manifest.json`,
`access.json`, `probe-ledger.jsonl`, `probe-state.json`, `completion.json`,
`comparative-report.json`, 1,200 files in `reports/` (two passes per root),
`operator-audit-key.json`, `review-packets.json`, and `review-template.md`.
Packets include the stored evidence, original policy and exact change needed to
judge correctness, with source IDs and the A/B assignment hidden. Keep the
operator key separate from the blinded packets. The test suite runs
this example in a disposable directory and verifies the persistent lock.
To reconstruct the retained report exactly, use its stored preregistration and
access time with fresh deterministic diagnostic reports; the regression test
performs that reconstruction.

## Exact operator review artifacts

Review these source-controlled artifacts:

1. [Generator and independent reference table](../../tools/decision/comparative-replay-corpus.ts),
   [corpus](../../test/fixtures/decision/comparative-replay/corpus.json),
   [gold](../../test/fixtures/decision/comparative-replay/gold.json), and
   [split membership](../../test/fixtures/decision/comparative-replay/split.json).
2. [Preregistration scaffold](evidence/comparative-replay-v1/preregistration.json),
   [local freeze manifest](evidence/comparative-replay-v1/freeze-manifest.json),
   [access record](evidence/comparative-replay-v1/access.json), and
   [comparative report](evidence/comparative-replay-v1/report.json).
3. [44-item operator audit key](../../test/fixtures/decision/comparative-replay/audit-sample.json)
   and [review template](../../test/fixtures/decision/comparative-replay/review-template.md).
   The [blinded contextual packets](evidence/comparative-replay-v1/review-packets.json)
   are also retained; the run directory supplies every diagnostic report.

The 44 assessments are 20 development oracle scenarios, 20 blinded test
report/gold pairs and four delayed intra-rater repeats. Two additional artifact
reviews cover the protocol and final report. No answers or approvals are filled
in. An ambiguous or incorrect gold item invalidates the affected analysis; do
not silently relabel, replace or exclude it. Only intra-rater repeat agreement
may be reported, not independent or inter-rater agreement.

Pending inputs: roctinam's 44 assessments and two signed/anchored artifact
reviews; an independently anchored protocol before access to a **new** holdout;
protected-artifact snapshot and verified upstream integrity receipts; and a
separately reviewed acceptance fix for the two observed boundary failures.
Live reevaluation requires a distinct approved integration because D23's current
input-reevaluation contract forbids external egress. Production cross-restart
anti-probing, deletion/backups and real-world usefulness remain open.

## Verification commands

Commands ran offline with existing dependencies. No full repository suite, build,
package installation or provider call was run.

| Command | Result |
| --- | --- |
| `nice -n 19 npx tsc --noEmit -p .` | Passed, zero diagnostics |
| `nice -n 19 npx tsc --noEmit --strict --skipLibCheck --target ES2022 --module ES2022 --moduleResolution bundler --esModuleInterop tools/decision/comparative-replay.ts tools/decision/comparative-replay-corpus.ts tools/decision/comparative-replay-assets.ts` | Passed, zero diagnostics |
| `nice -n 19 npx vitest run --config config/vitest.config.js test/unit/decision/comparative-replay.test.ts test/unit/decision/sensitivity.test.ts test/conformance/decision-v1/fixture-provenance.test.ts --maxWorkers=1` | Final run: 65 passed, zero failed |
| `nice -n 19 npx vitest run --config config/vitest.config.js test/unit/decision test/conformance/decision-v1 --maxWorkers=1` | 1,863 passed, 2 skipped, 2 child-output failures from inherited color-variable warnings |
| `nice -n 19 env -u NO_COLOR -u FORCE_COLOR npx vitest run --config config/vitest.config.js test/unit/decision/receipts.test.ts test/conformance/decision-v1/job-quota.test.ts --maxWorkers=1` | Both affected files passed: 35 tests, zero failed |
| `nice -n 19 npm run lint:test-registration` | Passed: 1,109 assigned sources |
| `nice -n 19 npm run lint:test-process-timeouts` | Passed: zero unbounded calls |
| `nice -n 19 npm run lint:schemas` | Passed: 197 compiled schemas, zero errors, two pre-existing fixture-marker warnings |
| `nice -n 19 npm run schema:catalog` | Refreshed catalog after staging schemas |
| `nice -n 19 npm run schema:catalog:check` | Passed: 106 authorities, 113 files |
| `nice -n 19 node --import tsx tools/decision/comparative-replay.ts` | Disabled; no artifacts written |
| `nice -n 19 node --import tsx tools/decision/comparative-replay.ts --replay` | Completed 600 roots twice, retained HOLD; initial missing-directory guard was corrected to honor `write_ready` |
| `git diff --check` and `git diff --cached --check` | Passed |

An earlier focused test run had one assertion expecting digest rejection where
schema admission rejected the malformed input first. The test now changes a
schema-valid quantity and proves the digest binding. No Markdown lint command or
binary is available in this checkout; no package was installed to add one.
