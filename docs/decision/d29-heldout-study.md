# D29 synthetic evidence screening study

Experimental, default-off, advisory only (#2622). The source study module is
`tools/decision/studies/d29.mjs`. It uses the shared collector without changing
collector core. No live collection, operator approval, calibration qualification,
or human review has been performed for this implementation.

## Prepare and approve

Run from this source checkout; no build, package installation, credentials or
network are needed:

```bash
nice -n 19 node tools/decision/d29-study.mjs --dry-run d29-study-v1
aiwg artifacts path --json --check-write
nice -n 19 node tools/decision/d29-study.mjs --prepare d29-study-v1 NEW_ARTIFACT_DIRECTORY
```

The new directory must be directly below the canonical artifact root returned
by the router. Preparation exclusively writes `corpus.json`, `gold.json`,
`preregistration.json`, `analysis.json`, `reviews.json` and
`approval-template.json`. Gold is separate and is never included in projected
provider state. Do not manually inspect final-test gold or predictions before
anchoring the preregistration and completing development review. A machine may
generate/hash gold; that does not constitute operator review.

The manifest pins all 1,600 memberships, source/scorer byte digests, seed,
synthetic provenance, gold digest and the separate analysis digest. Split
membership digests use `freezeQualificationSplit`. Each family has one newly
authored fictional world, allocated to one split before its hash-counter draws.
The seed is part of the family ID. Integer draws use rejection sampling over
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
resolver reference/digest, calibration basis, source/CI and titan workspace.
The template is deliberately invalid for collection until completed.

The proposed tariff is USD 0.042 per million input tokens, output free, no
request fee. The supplied evidence references are
[eesel](https://www.eesel.ai/blog/typesafe-jev-pricing),
[MindStudio](https://www.mindstudio.ai/blog/jev-pricing-cost-per-token), and
`roctinam/aiwg#2613 comment 153093`. These references were supplied by the
assignment; this offline implementation does not independently verify pricing.
The operator must attest them. Reservations use the collector's USD 0.10 per
million total-token floor, or a higher approved rate. Study cap: USD 6;
80% stop: USD 4.80, further reduced by prior spend.

One-line approval text, with the actual emitted values substituted:

```text
I, roctinam, approve D29 synthetic-only collection for preregistration <PREREGISTRATION_DIGEST>, analysis <ANALYSIS_DIGEST>, corpus <CORPUS_DIGEST> and completed approval <APPROVAL_DIGEST>, at USD 0.042/M input and free output, reserving at least USD 0.10/M total tokens within the USD 6 study cap; no gate, publication, efficiency or production promotion is authorized.
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

Labeling guide: an explicit matching port fact supports the claim; an explicit
different port contradicts it; a tentative fact is unclear; a color fact is
unrelated and does not support a port claim. A deployment checklist that lacks
rollback coverage is incomplete for a rollback criterion even if schemas/tests
pass. Missing artifacts and failed tests are non-ready regardless of semantic
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
A compatible D09 basis remains a required operator input for live use.

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
Calling the module's `score` without this context emits HOLD and the missing
inputs. Do not invoke the direct scorer on unverified production attempts.

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

| Planning case | Initial requests | Attempts | Tokens | USD |
| --- | ---: | ---: | ---: | ---: |
| Executable individual questions, 2.5% retry assumption | 4,500 | 4,612.5 expected | 9,225,000 expected input | 0.38745 estimated |
| Native batching assumption from design, not implemented in collector | 1,300 | 1,332.5 expected | 2,665,000 expected input | 0.11193 estimated |
| All individual questions retried once | 4,500 | 9,000 maximum | 36,000,000 total reserved | 3.60 reserved |

Expected attempts are fractional expectations, not observed calls. Expected
input is 2,000 tokens per attempt; output is free under the proposed tariff.
Worst-case per-request bound is 4,000 total tokens. Approved ceilings must be
at least 11,250 calls and 45,000,000 tokens to accommodate the 80% stop rule.
The permitted unbatched path fits the USD 6 cap. Concurrency remains one,
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
