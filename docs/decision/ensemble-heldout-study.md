# D17 synthetic ensemble held-out study

The D17 study module is experimental and default-off. It prepares a new,
deterministic synthetic corpus, preregistration, operator forms and offline
analysis on top of the [shared held-out collector](heldout-collector.md).
It changes no existing decision workflow. No live Jev collection, fitted D09
calibration, completed human audit or production qualification is supplied.

The module prepares one corpus under two preregistration scopes:

- **UNCALIBRATED diagnostic** (v1, `--prepare`): preregistration declares
  `calibration: { scope: 'uncalibrated-diagnostic', allowedModes:
  ['uncalibrated-diagnostic'] }`, and the approval declares `calibration: { mode:
  'uncalibrated-diagnostic' }`. Study reports carry `calibrated: false`,
  `d09Qualified: false` and `calibratedGate: false`, and stay HOLD or preserve an
  upstream ROLLBACK. Artifact and staged calibration approvals are refused under
  this preregistration. It cannot close AC7/AC14.
- **Staged D09 calibration** (v2 analysis, `--prepare-staged`): a calibration
  phase on the tuning and calibration splits, an operator-reviewed and
  D09-qualified calibration set fitted on calibration rows only, then a separate
  test-phase approval and calibrated scoring of the test split. This is the path
  that makes AC7/AC14 evaluable; see [Staged D09 calibration](#staged-d09-calibration).

Both scopes share the same corpus, split manifest, gold, review template and
native templates for a given seed. No genuine D09 artifact exists until a
staged calibration phase is collected, fitted and reviewed; a fixture digest
must never stand in for one.

## Frozen population and arms

`src/decision/ensemble-study/corpus.ts` allocates 1,800 fictional subjects:
200 development (`tuning`), 400 calibration and 1,200 final-test subjects.
Each split balances `yes`/`no` within direct facts, multi-fact relationships,
negation/insufficient evidence and authority-style distractors. Final-test
support is 300 per slice. Twelve authored grammar families are allocated to
splits before drawing parameters; different split grammars use different
state/relation vocabulary. Complete families stay in one split. Worlds and
parameter draws are independent within these shared templates; shared latent
operations and template effects limit transfer to real work.

The world-draw hash-counter prefix is
`aiwg-holdout-2497b51d-v1:D17:<split>:<familyId>:<row-index>:<k>`, with the seed digest in
the family ID and rejection sampling for bounded draws. A separately keyed
Fisher–Yates shuffle assigns balanced labels within each split and slice;
SHA-256 digests of a different seed/item domain form opaque record IDs.
Neither the ordinal seed nor the label is rendered in provider payloads or blind
review IDs. State words, relation verbs and names have fixed lengths within
each split so payload length does not reveal gold. Each row uses the closed
`<corpus-seed>:<index>:single` seed and the registered `d17-entailment/v1`
generator. The shared collector re-derives every row, its output digest, the
corpus seed and the generator source digest before dispatch. Labels follow an
executable latent-world oracle. A separately implemented text oracle checks
development rendering. Gold and latent worlds live in `gold.json`, separate
from provider payloads. Split manifests bind IDs, family memberships, slices,
input digests and duplicate checks. They do not expose per-item gold hashes.
Never copy existing fixtures or internal issue text into this population.

The champion receives one fresh invocation; the challenger receives three
fresh invocations of pinned `jev-1.13.0`. Champion output is never reused as
an ensemble member. The native policy template declares `repeated-sample`,
`samples: 3`, `mean-probability-v1`, three required successful members,
Jensen–Shannon disagreement at most 1,000 bps, tie/disagreement deferral,
member concurrency one and fallback depth zero. Native distributions remain
native; derived aggregate distributions are marked as derived stability
signals. Agreement does not establish correctness or calibration.

## Offline preparation from source

No build or credential is needed:

```bash
nice -n 19 node tools/decision/d17-study.mjs --dry-run d17-2611-v1
aiwg artifacts path --json --check-write
nice -n 19 node tools/decision/d17-study.mjs --prepare FRESH_OPERATOR_SEED OUTPUT_DIR
```

Choose `OUTPUT_DIR` immediately below the routed artifact root reported by the
second command. Preparation exclusively creates the directory and its files;
it will not overwrite an existing freeze. The first command writes nothing,
projects all inputs through the existing D10 helper and prints budget estimates
and canonical digests without exposing test labels. The documented
`d17-2611-v1` seed is an offline demonstration and must not be approved for a
paid held-out run: the source and seed are public enough to regenerate gold.
Use a fresh uninspected operator seed for any paid study and approve its newly
computed pins. Development
review must precede the external preregistration approval and test access.

The files include `corpus.json`, `preregistration.json`, `gold.json`,
`analysis.json`, `splitManifest.json`, `nativeTemplates.json`,
`reviewTemplate.json`, `guide.json`, `approval-template.json` and `dryRun.json`.
The preregistration binds the analysis digest, source-module byte digest and
corpus. It records the pre-collection gold-label leak correction, the three
superseded pins and an explicit no-live-observations declaration. The previous
corpus assigned labels by index parity and rendered that index in a record ID;
its pins are invalid for collection. Analysis binds every runtime source/schema file, dependency lock,
source runner and split/template digest. Source changes invalidate these pins.
The fixed protocol timestamp is a version marker; the separate immutable
operator record establishes the actual review/approval time.

Both native templates are deliberately incomplete: calibration, execution
identity, alias/rollback, eligibility and approval pins stay null until supplied
from real immutable records. The collection approval remains `approved: false`
and is invalid for dispatch. Diagnostic collection needs no calibration artifact
or calibration digest. The disabled native templates describe a future qualified
workflow and must remain incomplete under this scope. A future calibrated study
needs a new preregistration and genuine D09 evidence from calibration data only;
never invent calibrated flags, fixture artifact pins or eligibility records.

## Preregistered analysis

The closed v1 protocol fixes two-sided 95% intervals. All native comparisons
use candidate minus champion and require 1,200 complete test pairs:

| Metric | Native point bound | Additional study gate |
| --- | --- | --- |
| Quality | At least −0.03 | Newcombe-10 lower bound at least −300 bps; positive lower bound for a benefit claim |
| Calibration | Brier increase at most 0.02 | Paired percentile-bootstrap upper bound at most 0.02; seed 2611, 20,000 resamples; ECE reported separately |
| Risk-coverage | Accepted-error increase at most 0.01 | Wilson accepted-error upper bound at most 5%; coverage lower bound at least 60% |
| Abstention | Increase at most 0.05 | Paired interval upper bound at most 0.05 |
| Latency | Mean increase at most 10,000 ms | Paired distribution and p95 increase; p95 cap +15,000 ms |
| Tokens | Mean increase at most 8,000 | Retry overhead included; unknown usage remains missing |
| Cost | Mean increase at most 800 USD micros | Conservative reservation prices, including failures |
| Slice | Mean quality delta at least −0.03 | Four actual slice tables, 300 per slice, harm flagged |

Slice minimums establish support, not per-slice −3-point non-inferiority or
rare-error certification. Abstentions fail unconditional correctness. Missing
required endpoints block native reporting. Reports retain failure records,
complete-case diagnostics and a worst-case failure-as-error analysis; they
never substitute fabricated distributions or zero usage. Bootstrap intervals
are deterministic conditional on the frozen paired data. Latency is the sum of
collector attempt durations within each arm, including failed retries; it
excludes inter-dispatch pacing and journal persistence. The p95 comparison is
for that declared active-duration measure, not end-to-end session wall time.

The scorer uses native ensemble aggregation, paired helpers and the existing
ensemble report builder. The source study wrapper reproduces the prepared
pins before scoring. The shared `scoreHeldoutStudy` boundary rereads evidence
and validates externally digest-bound approval, scorer, gold and upstream
integrity. `buildD17NativeReport` also needs independently anchored report and
integrity digests plus a real champion/challenger record bound to the baseline
and statistical evidence. Scoring is a trusted host/library operation; the
collector CLI collects observations, not promotion approval. Replay a completed
protected run locally with:

```bash
nice -n 19 node tools/decision/d17-score.mjs SCORE_CONFIG.json OUTPUT.json
```

The closed config contains `run`, `trustedEvidenceDigest`,
`trustedApprovalDigest`, `goldFile`, `integrityFile` and
`trustedIntegrityDigest`. Supply the trusted digests from protected external
records; do not derive a new trusted pin from untrusted edited evidence.
The output must reside within the routed artifact root and is exclusively
created. This command performs no collection or credential resolution.

Economics compares candidate reservations with champion reservations and
reports net savings with its sign. Extra ensemble cost normally makes net
savings negative. D17 preregisters an additional-cost tolerance, not a savings
claim: an intended operational benefit additionally needs a positive lower
quality bound and a separately accepted cost/benefit tradeoff. A statistical
pass alone does not produce PROMOTE. The Brier, ECE and risk/coverage calculations
are descriptive diagnostics,
not D09 qualification or calibrated gates. D09 compatibility, blind review,
protected integrity evidence and separate operational approval remain external
inputs for a future qualified study; they cannot enable promotion under this scope.

## Staged D09 calibration

`src/decision/ensemble-study/staged.ts` reuses the diagnostic corpus, gold,
split manifest, review template and native templates unchanged; the corpus
module and its corpus pin do not move. Only these differ:

- Preregistration `calibration: { scope: 'calibrated', allowedModes: ['staged'],
  calibrationPhaseSplits: ['tuning', 'calibration'] }`, bound to a
  `decision-d17-analysis/v2` analysis.
- The v2 analysis adds the frozen `D17_CALIBRATION` protocol
  (`schemas/decision/D17StudyCalibration.v1.schema.json`).
- The approval form starts at `{ mode: 'staged', phase: 'calibration' }`.
- The dry run (`decision-d17-dry-run/v2`) splits the same 7,200 first attempts
  into a 2,400-attempt calibration phase (600 rows) and a 4,800-attempt test
  phase (1,200 rows).

The v1 schemas are unchanged; the staged artifacts use new schema versions
(`D17StudyAnalysis.v2`, `D17StudyDryRun.v2`, `D17StudyReport.v2` and
`D17StudyCalibration.v1`).

### Calibrators

Two calibrators are fitted on **calibration-split rows only**. Tuning rows are
collected and sealed with the phase but never fitted; test rows are outside the
calibration phase and the collector refuses them.

| Calibrator | Input | Fitted on | Applied to |
| --- | --- | --- | --- |
| `d17-single-call-isotonic` (member) | One fresh call's native P(yes) | All four single calls of every calibration row | The champion |
| `d17-three-sample-mean-isotonic` (aggregate) | Raw mean P(yes) of the three ensemble members | One mean per calibration row | The challenger |

Both use `isotonic-pav-laplace-v1`: pool-adjacent-violators on the observed
frequencies, blocks of at least 10 observations, Laplace-smoothed block
frequencies `(yes + 1) / (n + 2)` and a final monotone pass. The result is a
non-decreasing step function. Fitting requires at least 380 observed rows for
each calibrator (the 5% failure tolerance of 400).

At test time a calibrated probability of exactly 0.5 defers. The challenger is
accepted only when the native aggregate accepts (three members, Jensen–Shannon
disagreement, tie rule) **and** its calibrated value is not a tie.

Each calibrator becomes a `CalibrationArtifact.v1`. Its profile (at least 380
samples, 95 per slice, Wilson 95%, ECE at most 0.1, selective risk at most 0.1,
30-day expiry) is frozen in the analysis. The artifact metrics are in-sample on
the calibration split, and the artifacts say so. The approval carries one
`calibrationArtifactDigest` slot, so it binds the digest of a
`decision-d17-calibration-set/v1` record that pins both artifacts, both mapping
digests, the phase seal and the calibration-phase approval.

### Development review precondition

The 40 development assessments must be complete before calibrated work can
proceed: reviewer, preregistration review, review time, rationale, and a gold
audit label that agrees with both the generator gold and the independent text
oracle. Any `goldAmbiguousOrIncorrect: true` refuses and requires a revised
generator and a new holdout. Blind-test and repeat assessments must still be
blank at that point.

The review is enforced at four points, each against the operator's anchored
review digest:

1. `d17-study.mjs --bundle` assembles the collector's closed bundle only with a
   completed review.
2. `--fit-calibration` additionally requires every development review time to
   precede the phase seal.
3. `--register-calibration` re-checks the same review.
4. Staged test scoring re-checks it before scoring any row.

The shared collector cannot enforce the review itself. It is study-agnostic, its
`decision-heldout-approval/v1` schema is closed, and approvals carry no review
binding or timestamp. A hand-assembled bundle can therefore still collect
calibration-phase observations, but without a completed review no calibration
can be fitted or registered and no calibrated report can be produced.

### Gates

D17 has no `GateBinding`. The D29 gate-pack pattern does not apply, and the
calibrated report uses the frozen D17 native protocol (the table above),
evaluated on the calibrated champion and challenger measurements (`gates.source:
'd17-native-protocol'`, `gateBinding: null`). The uncalibrated v1 statistics are
retained alongside as `uncalibratedStatistics`, a descriptive comparison only.

The v2 report carries `calibrated: true`, `d09Qualified: true` and
`calibratedGate: true`. These mean that both approved artifacts resolved as
`allow` in the D09 registry at the scoring clock and stayed within the frozen
profile and selective-risk interval. The decision remains HOLD or a preserved
ROLLBACK: PROMOTE additionally needs a separately approved extra-cost tradeoff
and D09 promotion eligibility.

### Operator procedure

Use one artifact root throughout so the spend counter and the D17 baseline
carry across both phases. Every approval repeats the original budget (18,000
calls, 72 million tokens, USD 8) and the original prior-spend floors.

```bash
aiwg artifacts path --json --check-write
nice -n 19 node tools/decision/d17-study.mjs --dry-run-staged FRESH_OPERATOR_SEED
nice -n 19 node tools/decision/d17-study.mjs --prepare-staged FRESH_OPERATOR_SEED PREPARED_DIR
# Complete the 40 development assessments in a copy of reviewTemplate.json; anchor its heldoutDigest.
# Complete approval-template.json (calibration phase); anchor heldoutDigest(approval).
nice -n 19 node tools/decision/d17-study.mjs --bundle PREPARED_DIR APPROVAL.json DEV_REVIEW.json DEV_REVIEW_DIGEST CAL_BUNDLE.json
nice -n 19 node tools/decision/heldout-study.mjs --dry-run CAL_BUNDLE.json APPROVAL_DIGEST ARTIFACT_ROOT
AIWG_DECISION_HELDOUT_LIVE=1 nice -n 19 node tools/decision/heldout-study.mjs \
  --collect-approved CAL_BUNDLE.json APPROVAL_DIGEST ARTIFACT_ROOT
# Resume each 30-minute checkpoint with a new run ID and the same budget and floors,
# until summary.calibrationPhaseRecordDigest is set (the phase seal).
nice -n 19 node tools/decision/d17-study.mjs --fit-calibration RUN APPROVAL_DIGEST SEAL_DIGEST \
  DEV_REVIEW.json DEV_REVIEW_DIGEST FIT_DIR
# Review FIT_DIR; complete calibration-review-template.json; anchor its heldoutDigest.
nice -n 19 node tools/decision/d17-study.mjs --register-calibration RUN APPROVAL_DIGEST SEAL_DIGEST \
  DEV_REVIEW.json DEV_REVIEW_DIGEST CAL_REVIEW.json CAL_REVIEW_DIGEST REGISTERED_DIR
# Anchor the calibration-set digest. Complete REGISTERED_DIR/test-approval-template.json; anchor its digest.
nice -n 19 node tools/decision/d17-study.mjs --bundle PREPARED_DIR TEST_APPROVAL.json DEV_REVIEW.json DEV_REVIEW_DIGEST TEST_BUNDLE.json
AIWG_DECISION_HELDOUT_LIVE=1 nice -n 19 node tools/decision/heldout-study.mjs \
  --collect-approved TEST_BUNDLE.json TEST_APPROVAL_DIGEST ARTIFACT_ROOT
nice -n 19 node tools/decision/d17-score.mjs --staged STAGED_CONFIG.json SCORE.json
nice -n 19 node tools/decision/d17-score.mjs --native-handoff HANDOFF_CONFIG.json NATIVE_DIR
# Anchor the record and integrity digests.
nice -n 19 node tools/decision/d17-score.mjs --native NATIVE_CONFIG.json NATIVE_REPORT_DIR
```

`--fit-calibration` and `--register-calibration` read the run only through the
verified seal and regenerate the staged study from the sealed corpus seed. They
write observed (then approved) artifacts, mappings, the calibration set and an
unapproved test-phase approval form. Registration requires a
`decision-d17-calibration-review/v1` record whose digest the operator anchored,
and it refuses an artifact that does not qualify.

The `--staged` config adds `calibrationDir`, `trustedCalibrationSetDigest`,
`developmentReviewFile`, `trustedDevelopmentReviewDigest` and `evaluatedAt` (the
scoring clock, not in the future) to the diagnostic config keys.

`--native-handoff` re-scores under a locked artifact snapshot and requires the
anchored report digest to reproduce. It then emits the champion/challenger
record and eval-integrity metadata:

- Each role cites the D09 artifact applied to it.
- The integrity metadata binds the shadow baseline and the statistics digest.
- The release gate is capped at HOLD.

The handoff config adds `report`, `trustedReportDigest` and `operator`. The
`operator` fields are `alias`, `aliasRevision`, `eligibilityId`,
`integrityReportId`, `approvalReference` and `approvedAt`.

`--native` serializes `buildD17NativeReport` from the anchored record and
integrity digests. Without D09 promotion eligibility its decision is HOLD with
`d09-eligibility-missing`.

## Price, budget and live operator handoff

The template records the task-supplied USD 0.042 per million input-token rate,
free output and a zero request fee, with these evidence references:

- <https://www.eesel.ai/blog/typesafe-jev-pricing>
- <https://www.mindstudio.ai/blog/jev-pricing-cost-per-token>
- `roctinam/aiwg#2613 comment 153093`

These are supplied attestation references, not fetched or verified live here.
The operator must sign the price approval reference and confirm the fee/rates.
Reservations charge projected serialized UTF-8 request bytes plus the
preregistered 512-token provider overhead at the greater of the attested input
rate and USD 0.10 per million. The approval attests zero output price and a
zero request fee. The expected retry scenario below conservatively reserves
the full 3,744-token input allowance for each call. These are planning bounds,
never provider-reported charges:

| Quantity | Expected | Worst-case reservation |
| --- | --- | --- |
| Attempts, all three splits | 7,380 (7,200 initial plus 2.5% retries) | 14,400 |
| Tokens | 27,630,720 reserved input; output usage unknown | 57.6 million total, including output allowance |
| USD | 2.7675 | 5.4 |

Approval ceilings are 18,000 calls, 72 million tokens and USD 8 study spend.
The USD 48 portfolio cap and scanned/attested earlier spend also apply. The
worst case fits the collector's 80% stop threshold when the full budget remains.
Each request reserves before dispatch, with no refund. The 4,000-token bound
includes output/hidden allowance; conservative projection estimates are not
measured token usage. Thirty-minute sequential sessions require checkpoints
and resumptions. No soak or concurrent load is authorized.

Complete the approval with a clean exact source commit, matching CI evidence,
real reviewer/reference, titan workspace, region, scoped resolver reference
and byte digest, diagnostic calibration mode, execution digest, provider terms
and actual
prior study/portfolio spend. Bind the completed approval digest in an external
immutable record. Assemble the collector's closed bundle from only `corpus`,
`preregistration` and that approval. Its digest is canonical JSON via
`heldoutDigest`, not a formatted-file hash. Then the operator can run:

```bash
nice -n 19 node tools/decision/heldout-study.mjs \
  --dry-run BUNDLE.json APPROVAL_DIGEST ARTIFACT_ROOT
AIWG_DECISION_HELDOUT_LIVE=1 nice -n 19 node tools/decision/heldout-study.mjs \
  --collect-approved BUNDLE.json APPROVAL_DIGEST ARTIFACT_ROOT
```

The second command is an operator handoff, not authorization from this document.
Approval must precede any spend. The public-seed dry-run emits this placeholder
approval text; a paid run needs the form generated from its fresh pins:

> I, roctinam, approve D17 synthetic-only UNCALIBRATED diagnostic preregistration PREREGISTRATION_DIGEST and the separately completed priced approval digest APPROVAL_DIGEST, with USD 8 study/USD 48 portfolio caps and the frozen 88-assessment review protocol; no D09 qualification, calibrated gates or promotion are authorized.

## Operator review and remaining evidence

The deterministic review template supplies exactly 88 assessments:

- 40 development gold/guide checks, ten per slice, before freeze.
- 40 stratified blind test gold/result audits, ten per slice, after collection.
- Eight delayed repeat audits, two per slice, with prior answers hidden.

First audit test gold with model outputs hidden; then inspect blinded results.
Record labels, ambiguity/correctness flags, rationale and review time. An
ambiguous or incorrect gold item invalidates the affected preregistered
analysis. Never quietly relabel, replace or remove it: revise the generator
and use a new independent holdout. One reviewer supplies intra-rater repeats,
not independent or inter-rater agreement. Also review the preregistration and
final disposition; neither artifact review is one of the 88 assessments.

Offline tests establish deterministic generation, isolation, transport/budget
failure handling, statistical/report gates and the staged path: phase sealing,
calibration-only fitting, review-gated registration, D09 qualification,
calibrated scoring and the AC7/AC14 native record. AC7's measured ensemble
report and AC14's live integrity report remain **pending a staged live run**:
actual Jev observations for both phases, the operator-reviewed calibration set,
externally anchored integrity and completed blind review are still missing.
The diagnostic collection cannot close AC7/AC14 or qualify calibrated gates. Production risk-tier
benefit, independent-provider ensembles,
operational drift/rollback, actual promotion and rollout remain open. These
synthetic worlds cannot establish representative production performance.

## Offline handoff snapshot

For seed `d17-2611-v1`, the source-only dry run made zero provider calls and
produced these canonical JSON pins. These identify proposed artifacts, not an
operator approval, durable freeze or collected evaluation:

| Artifact | Digest |
| --- | --- |
| Corpus | `sha256:e268bf40c8f03d3b2b30a9919520705535bce6104b9fd892412388d20d2216b7` |
| Preregistration | source-derived: emitted by `--dry-run` at the approved source commit |
| Unapproved priced template | source-derived: emitted by `--dry-run` at the approved source commit |
| Split manifest | `sha256:09e2934e06781d8d64c65d104b8ee72ee87f3c48952eb2fe9333bb345862540f` |
| Analysis | source-derived: emitted by `--dry-run` at the approved source commit |
| Staged preregistration and v2 analysis | source-derived: emitted by `--dry-run-staged` at the approved source commit |
| Private gold | `sha256:865f5f28321f93a10be477a2b9095cbb2fa97cb3f5ee33b8f0fcd66b089d68db` |

Corpus rows, split and gold are data pins and stay fixed, and are identical under
both scopes. The corpus digest moves only through `provenance.generatorDigest`,
which pins the D17 corpus module bytes; the staged scope lives in a separate
module so that it does not move this pin.
Preregistration, the
priced template and analysis embed the digest of every source byte the study
runs, so they change with any shared decision-source change; they are bound at
approval time to the exact approved source commit, and the test suite checks
that they are well-formed and reproducible rather than pinning stale values.
This source-only dry run contains no live observations.

Pins will be regenerated at the new source commit before any operator freeze or
approval; the source dry-run values above were regenerated from the revised source
and identify only this offline demonstration. Recompute after any source/schema
change. Complete and attest the approval separately; its digest will differ from the unapproved template. The projected
maximum was 1,179 reserved input tokens, including the 512-token provider overhead;
a further 256-token output/hidden allowance fits under the 4,000-token bound.
This is not observed provider usage.

The workspace artifact router currently resolves to the worktree's `.aiwg`
directory. No durable study was written there. Configure/verify the intended
protected artifact store before preparation and preserve the external approval
record, source CI evidence and actual remaining budget before collection. The
shared collector now anchors study and portfolio baselines to a durable
hash-chained spend counter and independent head. A missing or altered counter
requires operator reconciliation; this source-only dry run creates no ledger.
