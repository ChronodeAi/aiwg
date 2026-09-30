# D29 synthetic evidence screening study

Experimental, default-off, advisory only (#2622). The source study module is
`tools/decision/studies/d29.mjs`. It reuses the shared collector, seal verification
and D09 registry. No live collection, phase approval, calibration qualification
or new human review is claimed for this implementation.

## Prepare and approve the calibration phase

Run from this source checkout; no build, package installation, credentials or
network are needed:

```bash
nice -n 19 node tools/decision/d29-study.mjs --dry-run d29-study-v2
aiwg artifacts path --json --check-write
nice -n 19 node tools/decision/d29-study.mjs --prepare d29-study-v2 NEW_ARTIFACT_DIRECTORY
```

The new directory must be directly below the canonical artifact root returned
by the router. Preparation exclusively writes `corpus.json`, `gold.json`,
`preregistration.json`, `analysis.json`, `reviews.json` and
`approval-template.json`. Gold is separate and is never included in projected
provider state. Do not manually inspect final-test gold or predictions before
anchoring the preregistration and completing development review. A machine may
generate/hash gold; that does not constitute operator review.

The manifest pins all 1,600 memberships, registered generator/scorer byte digests, seed,
synthetic provenance, gold digest and the separate analysis digest. Split
membership digests use `freezeQualificationSplit`. Each family has one newly
authored fictional world, allocated to one split before its hash-counter draws.
The seed is part of the family ID. Each row is re-derived by the collector's
`d29-synthetic/v1` registry entry, including its local outcome and request list.
Integer draws use rejection sampling over
SHA-256 of the common protocol string, with no model-dependent selection.
Source content uses canonical JSON digests, rather than file-format hashes.
Local locators identify the generated corpus inventory; they do not assert
that real external documents exist.

Review the 40 selected development items (five per slice), the latent oracle,
visible-text baseline and labeling guide below. Independently anchor the
preregistration and analysis digests in an immutable operator record with an
actual timestamp. Review the exact source commit and matching CI evidence.
Unknown approval fields remain null: they are mandatory inputs, not inferred
approvals. Fill the price attestation, actual prior study/portfolio spend,
provider terms, synthetic egress approval reference, declared region, scoped
resolver reference/digest, staged calibration-phase scope, source/CI and titan workspace.
The template is deliberately invalid for collection until completed.

The proposed tariff is USD 0.042 per million input tokens, output free, no
request fee. The supplied evidence references are
[eesel](https://www.eesel.ai/blog/typesafe-jev-pricing),
[MindStudio](https://www.mindstudio.ai/blog/jev-pricing-cost-per-token), and
`roctinam/aiwg#2613 comment 153093`. These references were supplied by the
assignment; this offline implementation does not independently verify pricing.
The operator must attest them. Input reservations use projected request UTF-8
bytes plus the preregistered 512-token provider overhead allowance, at no less
than USD 0.10 per million input tokens. The Jev approval must attest output
price exactly zero. Study cap: USD 6; 80% stop: USD 4.80, further reduced by
prior spend. The operator must reconcile actual prior study/portfolio spend with
the collector's baseline genesis, hash-chained counter and spend head before
approving a run; an incomplete or changed counter refuses collection.

The preregistration records that these source-only manifests were regenerated
with a new seed after the ambiguous contradiction gold was repaired, using
collector commit `0cbde8721`, before any live observations existed. The
previous `d29-study-v1` holdout is superseded; it must not be used for a paid
run. The new preregistration's `regeneration.priorLiveObservations` is zero;
it is not an observation or an
operator attestation. The current source dry-run reports corpus
`sha256:82b7c63a1bf821e2dcaf5bd0237348322a15ed8677cbabcacdf30f2f32591a00`,
preregistration `sha256:5fc3907d6364398c633e84d725c8b6a4ea10bb9e0e34cb85a5cb8e88ac750d02`,
analysis `sha256:3535d1e22a07c370eef14d95b74dddce1e0ac3e278b676a278779137f4488a7c`,
test membership `sha256:4acaca7184f02ade5cf6a88e90ae2188f991d0086c5cd14e9b1c6bf2a551f6ce`,
and incomplete calibration-phase approval template
`sha256:ae5193b1a4fe6e194a2544748371fc5b43c7cdfbca81bf41098b97bee9d25d28`.
The corpus additionally pins generator
`sha256:6ec07224263503201b99abfd3ea76a09e53c275c1855285e95230eed1af3f83e`
and separate gold
`sha256:215d5ee87122c567f0fc0be7a52d00e3c5bdf98b1f41254472209dd5c08a5f97`;
the preregistration pins scorer
`sha256:42a29259f0f73c1833f7613d1a48885235d29d710653a46863e54a068f6e1db7`.
The staged-flow update retains seed `d29-study-v2`, all 40 reviewed development
IDs, gold, generator behavior, oracle, baseline, slices and review selection.
The generator byte pin changes because the shared registry gained a lamp split
generator. The new preregistration permits only `staged`, with calibration-phase
splits exactly `tuning` and `calibration`; neither diagnostic nor independent
artifact mode can collect this study. Refresh the manifest anchors; the previous
single-approval digests do not authorize this flow.

One-line approval text, with the actual emitted values substituted:

```text
I, roctinam, approve D29 synthetic-only CALIBRATION-PHASE collection of tuning and calibration memberships only for preregistration <PREREGISTRATION_DIGEST>, analysis <ANALYSIS_DIGEST>, corpus <CORPUS_DIGEST> and completed approval <APPROVAL_DIGEST>, at USD 0.042/M input and free output, reserving projected UTF-8 bytes plus 512 provider overhead tokens at no less than USD 0.10/M input within the USD 6 study cap and reconciled spend counter; test collection/scoring requires a second approval bound to the sealed phase and reviewed D09 artifact; no gate, publication, efficiency or production promotion is authorized.
```

Assemble `bundle.json` with exactly `corpus`, `preregistration`, and the
completed `approval`. Anchor `heldoutDigest(bundle.approval)` externally;
it differs from the incomplete approval-template digest. Reusing a seed after
changing the generator is not an independent holdout. Freeze a new seed and
new protocol record when redesign is required.

The exact live command surface, for a future operator-approved run, is:

```bash
AIWG_DECISION_HELDOUT_LIVE=1 nice -n 19 node tools/decision/heldout-study.mjs \
  --collect-approved BUNDLE.json APPROVAL_DIGEST CANONICAL_ARTIFACT_ROOT
```

Before that command, run the shared `--dry-run` with the same three arguments.
It verifies execution pins, per-request projected payload bounds, source/root
attestations, prior spend and worst-case feasibility. This documentation is not
an approval. The 30-minute sessions checkpoint; resume with a new approved run
ID while keeping corpus and preregistration unchanged. Never remove an
uncertain-execution lock to force a retry. See the
[collector reconciliation rules](heldout-collector.md).

## Seal, fit, review, register and approve test access

The first phase stops after 400 subjects (1,100 initial question requests).
Successful completion emits `summary.calibrationPhaseRecordDigest` and the
exclusive `RUN/calibration-phase.json`. Anchor that digest and the completed
first approval independently. The seal binds all tuning/calibration memberships
and full journals, including reservations, failed attempts and resumed runs.
A checkpoint, uncertain dispatch or incomplete phase has no seal. Terminal
measurement failures may seal, but missing calibration observations still refuse
fitting. No test request is permitted by this approval.

After sealing, the following command is entirely offline. Its three inputs are
the sealed run directory, independently anchored first approval digest and seal
digest. Resolve the canonical artifact root first; output directories must be
new direct children of that root.

```bash
aiwg artifacts path --json --check-write
nice -n 19 node tools/decision/d29-study.mjs --fit-calibration \
  RUN CALIBRATION_APPROVAL_DIGEST SEAL_DIGEST NEW_FIT_DIRECTORY
```

It reconstructs the seal using the shared journal/trace validators, rechecks the
frozen D29 corpus and preregistration, and fits `fitReadinessMapping` from sealed
**calibration** attempts only. Tuning is collected but excluded from fitting;
test observations are unavailable to the fitter. It writes:

- `readiness-mapping.json`: the frozen four-cell Laplace mapping and attempt lineage.
- `calibration-artifact.json`: a closed `decision-calibration-artifact/v1`
  draft with full model/definitions/adapter/dataset/split/calibrator identity,
  `calibrator.parametersDigest` equal to the mapping digest, measured calibration
  metrics and explicit limitations. Its state is `observed`, with a null approval
  reference; that is not an approved or usable calibration artifact.
- `calibration-review-template.json`: the draft artifact digest, with approval,
  reference and review time left null for the operator.
- `test-approval-template.json`: an incomplete second approval bound to the draft
  artifact digest, sealed phase record and first approval digest.

The command prints `calibrationArtifactDigest` but performs no registration.
Fit diagnostics cover the 200 calibration rows, including 50 deterministic
blockers with probability zero; 150 rows fit the four semantic cells. ECE uses
the shared decile metric. Selective risk counts errors among readiness
probabilities >= 0.5; Wilson intervals describe that risk and each cell's
readiness rate, not ECE. The preregistered D09 profile requires 200 total samples,
25 per slice, ECE <= 0.1, selective risk point estimate and 95% Wilson upper bound
<= 0.1, and expiry after 30 days from sealing. These are in-sample synthetic fit
diagnostics, not independent test quality or production qualification.

Review the actual draft, mapping, sealed attempts, metrics and limitations.
Only the operator may complete `calibration-review-template.json` with
`approved: true`, an actual immutable `approvalReference` and `reviewedAt`.
Anchor its canonical `heldoutDigest` separately. A null, rejected, mismatched,
expired or insufficient review/artifact refuses registration. Run offline:

```bash
nice -n 19 node tools/decision/d29-study.mjs --register-calibration \
  RUN CALIBRATION_APPROVAL_DIGEST SEAL_DIGEST \
  COMPLETED_CALIBRATION_REVIEW.json REVIEW_DIGEST NEW_REGISTERED_DIRECTORY
```

This revalidates the sealed observations, applies the profile and registry
compatibility checks, registers the reviewed payload in `CalibrationRegistry`,
and persists the approved artifact, mapping, compatibility result and refreshed
test approval template. The approved artifact has a **new digest** because its
approval changed. Independently anchor that final `calibrationArtifactDigest`
and use only the refreshed template. The command's registry is process-local;
the protected scoring host must load the approved artifact into its genuine
`CalibrationRegistry` and resolve compatibility again at scoring time.

Registration does not approve test collection. Complete the refreshed test
approval with a new run ID and actual source/CI, price, egress and resolver
attestations, then independently anchor its approval digest. Keep the first
phase's budget and baseline prior-spend fields unchanged: the shared durable
counter already charges calibration spend against both phases. Never reset or
add that spend again as a new baseline. Suggested second approval text:

```text
I, roctinam, approve D29 TEST-PHASE collection for preregistration <PREREGISTRATION_DIGEST>, analysis <ANALYSIS_DIGEST>, corpus <CORPUS_DIGEST> and completed second approval <TEST_APPROVAL_DIGEST>, bound to reviewed/registered D09 artifact <FINAL_CALIBRATION_ARTIFACT_DIGEST>, sealed calibration phase <SEAL_DIGEST> and first approval <CALIBRATION_APPROVAL_DIGEST>, under the same reconciled USD 6 study cap and attested tariff; no gate, publication, efficiency or production promotion is authorized.
```

Assemble the second bundle with the original full corpus and preregistration
plus this second approval. Run the shared collector's `--dry-run` before the
separately enabled `--collect-approved` command above. It collects only the 1,200
test subjects (3,400 initial requests) and validates the seal/first-approval
handoff before test access. The D29 scorer additionally requires staged phase
`test` and exact equality between the approved artifact digest and the host's
independently trusted calibration digest. A matching digest alone is insufficient:
registry identity, approval, metrics, expiry and mapping pins must also pass.

## Population, oracle and baseline

| Split | Citations | Criteria | Total |
| --- | ---: | ---: | ---: |
| Tuning | 100 | 100 | 200 |
| Calibration | 100 | 100 | 200 |
| Final test | 800 | 400 | 1,200 |

Four citation slices have 200 test items each: `supports`, `contradicts`,
`unclear`, `does-not-support`. Four criterion slices have 100 each: semantic
readiness, semantic incompleteness despite hard-check pass, missing required
artifact and failed required test. Development splits have 25 per slice.
The latter two criterion slices fail deterministic preflight and make no
provider request: 300 subjects across all splits.

The oracle compares latent fact attributes/values and uncertainty, or required
coverage against established evidence; readiness also requires passed hard
checks and no injected instruction. Source text is authored from those worlds.
The baseline receives only visible source/claim or criterion/evidence text
and the same deterministic prerequisites. It recognizes exact facts and
contradictions, exact verified criterion statements, and reviews everything
else. Its route/support output is saved before computing correctness. It
cannot read latent worlds or gold. The deliberately narrow baseline is free;
no reviewer-time or cost saving is claimed.

Labeling guide: an explicit matching port fact supports the claim; a source
stating that the module uses exactly one, different port contradicts it.
A positive statement about a different port alone leaves the claim unclear.
A tentative fact is unclear; a color fact is unrelated and does not support a
port claim. The incomplete-criterion source explicitly states that the module
has no verified rollback coverage, even though it has a deployment checklist.
Missing artifacts and failed tests are non-ready regardless of semantic
answers. Instruction-bearing source text remains untrusted and non-ready.
The supplied injection variants occupy the unclear slice. Template effects,
limited language variation and transfer to real work remain limitations.

Review ambiguous or wrong gold as a protocol failure. Do not relabel, delete,
replace or expand the audit after seeing predictions. A revised generator
requires a new independent holdout.

## Observation and calibration path

The collector applies D10 projection/redaction to `input.payload` only.
Citations ask three bounded questions: four-label support, three-level support
strength and injection presence. Criteria ask five native choice questions:
relevance, completeness, contradiction, ambiguity and reviewer attention.
Question IDs, allowed outcomes and all source/criterion IDs come from host code.
Each answer is revalidated by the Jev adapter and retained in a digest-bound
receipt; the mapper preserves native distributions. Strength maps the native
ordinal value in [0,2] to [0,10000] bps with downward rounding. Confidence is
the minimum native question confidence, rounded down; it is never expanded
into a fabricated distribution or called correctness probability.

The scorer invokes the merged SDLC screening runtime with generated host
inventory, pinned gate policy and a genuine `CalibrationRegistry`. The
registered actual identity must match the served model, definitions,
calibration split and fitted mapping parameters; its independently trusted
artifact digest must resolve to `allow`. Unknown calibration fails closed.
No registry approval or compatibility evidence is fabricated by preparation.
A compatible reviewed D09 basis is required before the second approval and test scoring.

`fitReadinessMapping(prepared, attempts)` fits only calibration observations.
The prespecified cells are citation/criterion crossed with the native support
or completeness label suggesting readiness. Every cell needs at least ten
observations. Probabilities are `(ready + 1) / (n + 2)`, a frozen Laplace rule.
Deterministic prerequisite failures have readiness probability zero and make
no call. The fitted mapping's identity includes its calibration membership,
definitions and raw attempt lineage. Test gold and single native confidence
never fit this mapping. A fitted mapping alone is not D09 qualification.

For scoring, use `scoreHeldoutStudy` with `studyModule(context)`. The shared
wrapper rereads and verifies recorded journals/traces, prior runs, approval,
gold, source-module and integrity pins. The context contains independently
anchored analysis/integrity/access/mapping/calibration/review digests, the
mapping and registry compatibility request/policy, completed reviews and a
clock. The access record is `decision-d29-access/v1` with `analysisDigest`,
`anchoredAt`, `firstTestAccessAt`, and an external immutable `reference`.
Recording a future evaluation time is not proof of access history.
`studyModule(context)` verifies the collector's test-only corpus projection
against the full frozen corpus before scoring. It consumes the pinned frozen
mapping; it never refits from test attempts. Calling the direct `score` without
this approved context refuses scoring. Do not invoke the direct scorer on unverified production attempts.

## Gates and interpretation

Native preregistration freezes total N >= 1,200, each slice N >= 100, aggregate
blocking N >= 200, Wilson/9500 error intervals, false-support and false-ready
upper caps of 100 bps, and a 300 bps paired Newcombe non-inferiority margin.
`buildSdlcScreeningReleaseReport` applies these thresholds and preserves
upstream HOLD/ROLLBACK. Efficiency is disabled with a null minimum benefit;
when requested through the report API, existing native net-baseline economics
checks remain mandatory. A costlier candidate cannot pass an efficiency claim.

False-support divides erroneous ready/support suggestions by all 800 citations.
False-ready divides erroneous ready suggestions by all 1,200 subjects. Their
95%/1% caps permit at most two and five events respectively. External reporting
also shows conditional errors among non-support/non-ready gold and among
accepted suggestions, with each denominator, all four support-class
precision/recall and the full support/readiness confusion tables.

External gates require the Wilson accepted-coverage lower bound >= 15%, zero
false-ready events per blocking slice, and a <= 5% Wilson upper bound in each
such slice. Zero events in 100 gives an outward-rounded 370 bps upper bound;
it is not a 1% slice certificate. An all-review policy cannot pass coverage.
Slice minimums ensure representation, not separate per-slice NI power.

Any missing required observation withholds the native measured report. The
scorer retains a complete-case descriptive appendix and a paired
failure-as-error analysis using all 1,200 IDs, with missing candidate outcomes
counted incorrect. It never invents native distributions or calibrated values
for failed measurements. Unknown provider dollars remain null. Reservation
amounts are reported separately in provenance and are not provider charges.
The top-level study disposition always remains HOLD or ROLLBACK; passing
statistical diagnostics are not production authorization.

## Operator workload and resource plan

`reviews.json` has 132 empty assessments: 40 development, 80 unique test items
(ten per slice), and 12 delayed repeats. For each test item, first audit gold
with suggestions hidden and record correctness/rationale/time; then unblind
and record agreement/override/rationale/time. Repeat assessments must occur
after the first assessment's unblinding. Only the 80 unique holdout items
populate native `reviewer`; the other 1,120 remain null. Disclose reviewer N=80,
one reviewer, modest agreement precision and no inter-rater claim. Review the
preregistration and final disposition as two additional artifact reviews.
The JSON template supports this two-phase local review; no web review UI ships.

| Source-only planning case | Initial requests | Attempts | Tokens | USD |
| --- | ---: | ---: | ---: | ---: |
| Individual questions, 2.5% retry assumption | 4,500 | 4,612.5 expected | 4,587,057.45 input reserved; 5,767,857.45 total reserved | 0.1926564129 input at attested tariff; 0.460904575 reserved |
| Every individual question retried once | 4,500 | 9,000 maximum | 8,950,356 input reserved; 11,254,356 total reserved | 0.899326 reserved |

The table totals both separately approved phases; the first approval cannot
spend the test portion. Expected attempts are fractional expectations, not observed calls. These
figures use the source dry-run's `fixture-region` projection identity; a real
approved region can change serialized bytes. Run the shared collector
`--dry-run` against the completed approval for authoritative preflight numbers.
The 256 output/hidden token allowance counts toward reserved tokens, while
free output adds no reserved dollars. The preregistered per-request bound is
4,000 total tokens. The template ceilings are 11,250 calls and 45,000,000
tokens so the 80% stop rule leaves room for this path. Concurrency remains one,
dispatch intervals at least one second; this is resumable collection, not a
soak or load qualification. No generative judge or executor is needed.

## Evidence disposition

Offline tests: `test/unit/decision/d29-study.test.mjs`, the shared collector
suite, existing SDLC screening/regression suites, paired quality helpers and
D13 restart tests. Fixture responses and fixture calibration/reviews are
explicitly offline and are not study results. Disabled mode preserves the
serialized host-supplied outcome. There is still no programmatic AIWG phase-gate
integration; see [the host pass-through boundary](sdlc-screening.md).

| Acceptance criteria | Implemented evidence / exact remaining input |
| --- | --- |
| AC1–7 | Closed questions, receipt mapping and existing runtime authority controls; offline deterministic tests. Real source/validator deployment remains outside this synthetic study. |
| AC8 | Scorer, native metrics, four-class/conditional extensions, receipt lineage; pending actual Jev observations, compatible calibrated mapping and 132 completed operator assessments. |
| AC9 | Frozen manifests and executable native/external gates; pending independent operator digest anchoring and actual holdout access log before spend. |
| AC10 | Existing D13 disposable-store restart/idempotency tests; no real gate transition or operator review has been run. |
| AC11–12 | Default-off collection and byte-identical host outcome pass-through tests; actual programmatic SDLC host integration remains unavailable. |
| AC13 | Digest-validated integrity and conservative serialization; pending protected real eval-integrity snapshot and measured data. |

A fully human-adjudicated representative 1,200-item corpus, real-world SDLC
readiness, production rollout, independent reviewers, positive economics and
publication authorization remain open. This study only targets a narrow
synthetic diagnostic claim, including a valid negative/HOLD result.
