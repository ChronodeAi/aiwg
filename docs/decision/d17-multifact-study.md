# D17-MF: multi-fact reasoning probe

D17-MF is an experimental, default-off, preregistered probe of Jev's
(`jev-1.13.0`) multi-fact reasoning ([#2850](https://git.integrolabs.net/roctinam/aiwg/issues/2850)).
It follows up on the [D17 calibrated live run](ensemble-heldout-study.md),
where every study error fell in the multi-fact slice.

No live collection is included. Collection runs through the
[shared held-out collector](heldout-collector.md) after operator approval.

## Why: the D17 finding and the no-spend diagnosis

On the D17 test split, multi-fact accuracy was 0.7833 for the champion (single
call) and 0.7567 for the challenger (3-call mean). On the calibration split it
was 0.95 and 0.92 out-of-fold. The diagnosis re-read the existing 7,200 D17
observations without new calls; aggregates are in
`.aiwg/research/d17-multifact-diagnosis-2026-10-02.json`.

The whole degradation is one failure type: rows whose missing link is written
with the pool's **contrastive verb**.

| Grammar (split) | Contrastive verb | Raw accuracy, missing link | Calibrated champion | Disabled relay | Yes rows |
| --- | --- | --- | --- | --- | --- |
| tuning | `bypasses` | 0.67 (n=9) | 0.89 | 1.00 | 1.00 |
| calibration | `blocks` | 0.36 (n=25) | 0.84 | 1.00 | 1.00 |
| test | `halts` | 0.00 (n=73) | 0.16 | 1.00 | 0.97 |

- On the test grammar, Jev answers "established" for every `B halts C` link.
- The D17 member calibrator was fitted on the calibration grammar's `blocks`
  items. It learned to discount those moderate scores, which produced the
  optimistic out-of-fold figures.
- Model selection (BIC over every subset of the recorded factors) keeps exactly
  grammar × failure type. Day, quantity and name features add nothing.
- D17 fixes one relay hop and one rule form, so reasoning depth was untestable
  from the existing data.

## Hypotheses (preregistered)

| Id | Hypothesis |
| --- | --- |
| H1 | Wording: missing-link accuracy depends on the wording pool at fixed hops and encoding. |
| H2 | Depth: accuracy falls from one relay hop to three, at fixed pool and outcome. |
| H3 | Missing-link polarity: a missing link is read as established (permissive linking), while a disabled relay is handled. |
| H3a | Encoding: the failure is specific to the contrastive verb rather than to missing links in general. |
| H4 | Layout: D17's rendering differs from the equalized rendering at one hop. |

The decision rules are frozen in `D17MF_PROTOCOL.decisionRules`
(`src/decision/ensemble-study/multifact-study.ts`).

- **Intervals.** Cell accuracies use Wilson 95% intervals. Contrasts use
  Newcombe hybrid-score 95% intervals for independent proportions.
- **H1** needs a pool pair differing by at least 0.10, with its interval
  excluding 0, at both hop levels.
- **H2** needs `accuracy(h3) - accuracy(h1)` to have an upper bound below
  −0.05 in two of three pools.
- **H3** needs every pool to show relay-off minus missing-link accuracy with a
  lower bound above 0.10, and a "yes" rate above one half on that encoding.
- **H3a** is decided between "contrastive-specific", "general" and "mixed".
- **Replication** of the D17 failure needs the D17-faithful `halts` cell to have
  an upper bound of at most 0.50.
- **Calibration under shift:** a cell is flagged when calibrated confidence
  exceeds accuracy by more than 0.10.
- **Decision:** the study decision is always HOLD. This is a provider
  diagnostic, not a promotion.

## Design

`src/decision/ensemble-study/multifact.ts` registers the generator
`d17-multifact/v1`, through the outer registry
`src/decision/heldout/study-generators.ts`. The D17 and D29 generator pins are
unchanged.

**Factors**

| Factor | Levels |
| --- | --- |
| Wording pool | The three disjoint D17 grammars: pool-a (`connects`/`bypasses`), pool-b (`routes`/`blocks`), pool-c (`links`/`halts`) |
| Relay hops | 1 and 3 |
| Outcome | yes, relay-off (a disabled relay), missing link as a contrastive verb, as an explicit negation (`does not link`), or as a length-matched unrelated verb (`observes`/`audits`/`hails`) |
| Layout | equalized; D17-faithful control (one hop, D17 rule, D17 names) |

**Cells**

| Cells | Rows each | Count |
| --- | --- | --- |
| Equalized missing-link: 3 pools × 2 hops × 3 encodings (key cells) | 250 | 18 |
| Equalized yes: 3 pools × 2 hops | 90 | 6 |
| Equalized relay-off: 3 pools × 2 hops | 60 | 6 |
| D17-faithful control: 3 pools × {yes, contrastive} | 50 | 6 |
| Development rows (2 per cell, split `tuning`) | 2 | 36 |

- That is 5,700 probe rows plus 72 development rows, 5,772 in total.
- At p = 0.5 a key cell's Wilson half-width is 0.062. It is narrower near the
  observed extremes.
- With 250 rows per side, a Newcombe contrast detects about 0.12 at 80% power.
- **Why hops are 1 and 3, not 1, 2 and 3:** the shared collector's credential
  scan bounds one corpus at about 5,880 rows (100,000 nodes at 17 per row). Using
  the endpoints keeps the preregistered h3 − h1 contrast at full power.
- **Failure positions** (which link or relay breaks) are balanced within each
  cell.
- **Gold** comes from latent-world reachability. A separate text oracle
  re-derives every label from the rendered facts.

### Shortcut control (D29 audit principle)

In D17's rendering the contrastive verb alone predicts "no". D17-MF therefore
equalizes cues in every equalized item:

- Each cue class (positive links, enabled states, contrastive verbs, negations,
  unrelated verbs, disabled states) appears a label-independent number of
  times, drawn from {1, 2} or a hop-dependent pair.
- Off-chain decoy lines among four decoy entities fill each class up to its
  target. The decoy relation lines use distinct ordered pairs and never touch
  the chain, so they cannot contradict each other or create paths.
- Paired words have equal lengths, every name has five characters, and the
  distinct-entity count is fixed per hop level.
- Only *which* lines lie on the subject-to-destination chain decides the label.

The preparation runs a shortcut audit and refuses if it fails. Within each
pool × hops group of equalized test rows, three learners try to predict gold:

- a cross-validated best single scalar threshold;
- a cross-validated best token-count threshold;
- a cross-validated depth-2 tree.

The scalar features are lines, characters, digits, words, cue counts, entities,
and subject and destination mentions. Entity names are abstracted.

- No learner may exceed balanced accuracy 0.60 on equalized rows. On a public
  seed the maximum is 0.541.
- The D17-faithful control is audited and reported separately. It is expected
  to be cue-solvable (1.0), because it reproduces D17.

## Calibrated evaluation

The probe is calibrated in collector `artifact` mode. The approval binds the
registered D17 calibration set digest, and the scorer applies the D17 member
(single-call) isotonic calibrator to the one fresh call per row.

**Why not a new staged calibration?** The probe asks whether Jev's reasoning,
and the deployed calibration, survive wording, depth and polarity shift. A
calibrator fitted on the shifted pools would absorb exactly the miscalibration
the probe measures.

The registered calibrator is never trusted blindly. `--score` re-derives the D17
calibration set from its sealed calibration phase (re-fit, out-of-fold metrics,
both reviews) and requires the registered files to match. It then qualifies the
member artifact at the scoring clock: approved, unexpired, and within the frozen
profile.

The artifact's 30-day expiry runs from 2026-10-02T10:02:38Z. **Scoring must
happen before 2026-11-01T10:02:38Z.** The probe reuses the D17
DecisionDefinition byte-identically, so the artifact identity applies; this is
asserted in tests.

## Operator procedure

```bash
nice -n 19 node tools/decision/d17-multifact.mjs --dry-run FRESH_OPERATOR_SEED
nice -n 19 node tools/decision/d17-multifact.mjs --prepare FRESH_OPERATOR_SEED PREPARED_DIR
# Complete the 40 development assessments in reviewTemplate.json; anchor DEV_REVIEW_DIGEST.
# Complete approval-template.json:
#   - calibration { mode: 'artifact', calibrationArtifactDigest: REGISTERED_D17_SET_DIGEST }
#   - budget 16,000 calls / 30M tokens / USD 5
#   - the attested prior D17 and portfolio spend floors
#   - an approvalReference that cites DEV_REVIEW_DIGEST
nice -n 19 node tools/decision/d17-multifact.mjs --bundle PREPARED_DIR APPROVAL.json DEV_REVIEW.json DEV_REVIEW_DIGEST BUNDLE.json
nice -n 19 node tools/decision/heldout-study.mjs --dry-run BUNDLE.json APPROVAL_DIGEST ARTIFACT_ROOT
AIWG_DECISION_HELDOUT_LIVE=1 nice -n 19 node tools/decision/heldout-study.mjs --collect-approved BUNDLE.json APPROVAL_DIGEST ARTIFACT_ROOT
# Resume each 30-minute checkpoint with a new run ID until complete.
nice -n 19 node tools/decision/d17-multifact.mjs --score SCORE_CONFIG.json SCORE.json
```

Use a fresh artifact root. Attest the D17 spend so far as the study floor and
the program total as the portfolio floor; the collector records them as the new
ledger's baselines.

**The score config** names these files:
- the run, the gold, and the integrity file;
- the D17 calibration run (the sealed `c03` phase) and the registered D17
  directory;
- the D17 calibration and development reviews.

It takes the trusted digests for each, plus `evaluatedAt`. `evaluatedAt` may not
precede the first test access or be in the future.

**Budget.** The worst case is 11,544 calls, 19.05M reserved tokens and USD 1.614
reserved, at the USD 0.10/1M reservation floor. Against a 16,000 / 30M / USD 5
budget, the allowance is 12,800 calls, 24M tokens and USD 4.0. The expected
reservation is about USD 0.83, roughly USD 0.34 at the published USD 0.042/1M.

## Remaining

- The live run, after independent review and operator go-ahead.
- The operator-delegated development review.
- The results summary, with the probe's cell table and hypothesis verdicts.
