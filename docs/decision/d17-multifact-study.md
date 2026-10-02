# D17-MF: multi-fact reasoning probe

D17-MF is an experimental, default-off, preregistered probe of Jev's
(`jev-1.13.0`) multi-fact reasoning ([#2850](https://git.integrolabs.net/roctinam/aiwg/issues/2850)).
It follows up on the [D17 calibrated live run](ensemble-heldout-study.md),
where every study error fell in the multi-fact slice.

No live collection is included. Collection runs through the
[shared held-out collector](heldout-collector.md) after operator approval.

## Why: the D17 finding and the no-spend diagnosis

On the D17 test split, multi-fact accuracy was 0.7833 for the champion (single
call) and 0.7567 for the challenger (3-call mean). The calibration split
measured differently depending on the basis:

- **Out-of-fold** (the D09 qualification metrics, from the fit report): 0.95
  champion, 0.92 challenger.
- **In-sample** (full-split mapping, used in the diagnosis below): 0.96 and
  0.93.

The diagnosis re-read the existing 7,200 D17 observations without new calls;
aggregates are in `.aiwg/research/d17-multifact-diagnosis-2026-10-02.json`. The
whole degradation is one failure type: rows whose missing link is written with
the pool's **contrastive verb**.

| Grammar (split) | Contrastive verb | Raw accuracy, missing link | Calibrated champion, in-sample | Disabled relay | Yes rows |
| --- | --- | --- | --- | --- | --- |
| tuning | `bypasses` | 0.67 (n=9) | 0.89 | 1.00 | 1.00 |
| calibration | `blocks` | 0.36 (n=25) | 0.84 | 1.00 | 1.00 |
| test | `halts` | 0.00 (n=73) | 0.16 | 1.00 | 0.97 |

- On the test grammar, Jev answers "established" for every `B halts C` link.
- The D17 member calibrator was fitted on the calibration grammar. It learned to
  discount those moderate `blocks` scores, which produced the optimistic
  calibration-split figures.
- Model selection (BIC over every subset of the recorded factors) keeps exactly
  grammar × failure type.

## Hypotheses (preregistered)

| Id | Hypothesis |
| --- | --- |
| H1 | Wording: missing-link raw accuracy depends on the wording pool at fixed hops and encoding. |
| H2 | Depth: raw accuracy falls from one relay hop to three, at fixed pool, outcome and failure position (first or last). |
| H3 | Missing-link polarity: a missing link is read as established (permissive linking), while a disabled relay is handled. |
| H3a | Encoding: the failure is specific to the contrastive verb rather than to missing links in general; pure absence is the baseline. |
| H4 | Layout: at one hop and the last link, the D17-faithful rendering differs from the equalized one. |

### Metrics

- **Primary reasoning metrics** are independent of any calibrator:
  - the raw native answer (P(yes) > 0.5) per cell, with a Wilson 95% interval;
  - the AUROC of the raw P(yes) between yes rows and missing-link rows, per
    pool × hops (pooled and per encoding), with a Hanley–McNeil 95% interval.
- **Calibrated metrics** (accuracy, mean confidence, decile ECE through the
  registered D17 member calibrator) serve only the calibration-under-shift
  rule. That calibrator was fitted on the pool-b grammar, so calibrated answers
  would confound pool contrasts with where it sets its threshold. Both are
  reported.

### Decision rules

The rules are frozen in `D17MF_PROTOCOL.decisionRules`
(`src/decision/ensemble-study/multifact-study.ts`).

- **H1** uses Holm across the whole family of pool-pair contrasts
  (family-wise 0.05, two-sided pooled two-proportion z). It needs
  |difference| ≥ 0.10 at every hop level of an encoding.
- **H2** restricts both arms to first- and last-position failures, and needs a
  Newcombe 95% upper bound below −0.05 in two of three pools.
- **H3** needs relay-off minus missing-link accuracy to have a lower bound above
  0.10 in every pool, with "yes" answers on more than half of that encoding's
  rows.
- **H3a** decides between "contrastive-specific", "general" and "mixed". The
  pure-absence baseline is reported against interior-position contrastive rows.
- **H4** is Holm-adjusted across the three pools and compares last-link failures
  only. The faithful control always breaks the relay-to-destination link; the
  unmatched contrast is reported too. H4 bundles four differences:
  1. rule wording (D17's sufficient one-relay rule vs the exhaustive link-only
     rule);
  2. line order (fixed vs uniformly shuffled);
  3. decoy lines (none vs label-independent decoys);
  4. entity names (role-prefixed vs neutral).
- **Replication** of D17 needs the pool-c faithful `halts` cell to have a raw
  accuracy upper bound of at most 0.50.
- **Coverage gate:** every test cell must reach 95% observed rows. Otherwise the
  report is marked incomplete and every verdict is "insufficient".
- **Accuracy by failure position** (first, interior, last) is reported for every
  cell.
- **Decision:** always HOLD. This is a provider diagnostic, not a promotion.

## Design

`src/decision/ensemble-study/multifact.ts` registers the generator
`d17-multifact/v1`, through the outer registry
`src/decision/heldout/study-generators.ts`. The D17 and D29 generator pins are
unchanged, and the D17-MF digest covers the generator and the hash module it
imports.

**Factors**

| Factor | Levels |
| --- | --- |
| Wording pool | The three disjoint D17 grammars |
| Relay hops | 1 and 3 |
| Outcome | yes; relay-off; missing link written as the contrastive verb, as an explicit negation (`does not link`), or as a non-connective verb; or not stated at all (pure absence, 3 hops, interior link) |
| Layout | equalized; D17-faithful control |

**Pools**

| Pool | Link verb | Contrastive | Non-connective | Enabled / disabled |
| --- | --- | --- | --- | --- |
| pool-a | `connects` | `bypasses` | `lacquers` | `enabled` / `blocked` |
| pool-b | `routes` | `blocks` | `paints` | `active` / `paused` |
| pool-c | `links` | `halts` | `cooks` | `powered` / `dormant` |

The non-connective verbs come from unrelated semantic fields. Each matches its
link verb's length and shares no letter position with the contrastive verb
except the final "s".

**Rule.** Every equalized item states an exhaustive, link-only rule:

> An entity can reach a destination exactly when a sequence of stated facts of
> the form "X `<link-verb>` Y" leads from it to that destination and every
> entity in between is `<enabled>`; no other relation counts.

A contrastive, negated or non-connective verb therefore cannot make
missing-link gold contestable.

**Cells**

| Cells | Rows each |
| --- | --- |
| Equalized missing-link (key): 3 pools × 2 hops × 3 written encodings, plus pure absence × 3 pools at 3 hops (21 cells) | 220 |
| Equalized yes: 3 pools × 2 hops | 110 |
| Equalized relay-off: 3 pools × 2 hops | 40 |
| D17-faithful control: 3 pools × {yes, contrastive}, one hop | 30 |
| Development rows (`tuning` split) | 2 per cell, 78 in total |

**Sizing and power**

- 5,700 probe rows plus 78 development rows: 5,778 in total.
- Key-cell Wilson half-width is 0.066 at p = 0.5, and at most 0.05 below 0.17 or
  above 0.83.
- A Newcombe contrast of two key cells detects about 0.13 at 80% power.
- Yes rows were raised to 110 because they are the smaller class of every
  shortcut-audit group, which bounds the audit's noise.

**Limitations forced by the row bound.** The shared credential scan bounds one
corpus at about 5,880 rows (100,000 nodes at 17 per row). As a result:

- hops are the endpoints 1 and 3;
- pure absence exists only at three hops, where an interior link can be left
  unstated without changing how often the query entities are mentioned;
- **no verb × framing cross-cell fits.** Within a pool the link verb and the
  framing sentence co-vary, so H1 attributes a pool difference to the pool
  wording as a whole, not to the verb alone.

**Failure positions** are balanced within cells:

- links 0..hops for written encodings;
- interior links for absence;
- relays 0..hops−1 for relay-off.

**Dispatch.** Development rows come first, then the test rows in a seeded
Fisher–Yates permutation. Its digest is preregistered as
`analysis.dispatchOrderDigest`, so collection interleaves cells instead of
running them in blocks.

**Gold.** Gold comes from latent-world reachability, and a separate text oracle
re-derives every label.

### Shortcut control (D29 audit principle)

In every equalized item:

- each cue class (link, enabled, contrastive, negation, non-connective,
  disabled) appears a label-independent number of times;
- off-chain decoy lines among four decoy entities fill each class up to its
  target, using distinct ordered pairs, so decoy facts never contradict each
  other or create paths;
- **all fact lines are shuffled uniformly**, with the rule last;
- names are five characters with distinct two-letter prefixes;
- the distinct-entity count is fixed per hop level.

Preparation runs the shortcut audit and refuses if it fails. Within each
pool × hops group of equalized test rows, four cross-validated learners try to
predict gold:

- a best single scalar threshold;
- a best token-count threshold;
- a depth-2 tree;
- an L2 logistic regression.

The features are counts, lengths, entity mentions, the mean, minimum and maximum
normalized line position of each cue class, the positions and order of the
first lines mentioning the query subject and destination, and the classes of the
first and last fact lines.

**Audit results**

| Run | Maximum balanced accuracy |
| --- | --- |
| Public demo seed `d17mf-public-demo` | 0.552 |
| 24 sweep seeds `d17mf-sweep-0` … `d17mf-sweep-23` | at most 0.594 (median 0.566); all pass the 0.60 limit |
| Positive control: the earlier chain-first line order | > 0.60, fails (regression-tested) |
| D17-faithful control (audited separately) | 1.0: D17's rendering is cue-solvable |

## Calibrated evaluation

The probe is calibrated in collector `artifact` mode. The approval binds the
registered D17 calibration set digest, and the scorer applies the D17 member
(single-call) isotonic calibrator to the one fresh call per row.

**Why not a new staged calibration?** A calibrator fitted on the shifted pools
would absorb exactly the miscalibration this probe measures.

The registered calibrator is re-derived from the D17 seal (re-fit, out-of-fold
metrics, both reviews; the registered files must match), and the member artifact
is qualified at three points:

1. at bundle time;
2. at collection end;
3. at the scoring clock.

The artifact expires **2026-11-01T10:02:38Z**, so collection and scoring must
finish before then. The probe reuses the D17 DecisionDefinition byte-identically
(asserted in tests).

**Scoring clock.** The collector records no per-attempt wall-clock time. Its
only recorded time is each session's `qualification.json` `generatedAt`, the
collector's clock at the end of the session; it is not independently anchored.
`--score` therefore requires `evaluatedAt` to be:

- at least the latest such end across the run lineage;
- at most now.

Collection and scoring run at the exact approved source commit:

- the collector checks the commit for every dispatch;
- the scorer regenerates the study from source and refuses changed
  preregistration pins.

## Seeds and budget

**Seeds.**

- Public and review seeds can regenerate gold from source, so `--bundle` and
  `--dry-run-ledger` refuse them. The list covers `d17mf-offline`,
  `d17mf-public-demo`, `d17mf-smoke`, the review seeds, and the prefixes
  `review-` and `d17mf-offline|public|smoke|sweep|demo`.
- Use a fresh private seed. `--dry-run-ledger` also refuses a seed whose corpus
  already has observations under another preregistration in the ledger.

**Budget.**

- This study's budget is 16,000 calls / 30M tokens / USD 5.
- It shares the **D17 study cap of USD 8** with the D17 runs. The approval
  attests all prior D17 spend as the study floor (USD 0.892652 so far) and the
  program total as the portfolio floor (USD 2.192652 so far).
- The worst case is 11,556 calls, 19.96M reserved tokens and USD 1.706
  reserved, at the USD 0.10/1M reservation floor.
- On a fresh ledger the allowance is 12,800 calls, 24M tokens and USD 4.0. That
  leaves 1,244 calls, 4.0M tokens and USD 2.29 of headroom.
- Expected spend is about USD 0.87 reserved, roughly USD 0.36 at the published
  USD 0.042/1M.

## Operator procedure

```bash
nice -n 19 node tools/decision/d17-multifact.mjs --dry-run FRESH_PRIVATE_SEED
nice -n 19 node tools/decision/d17-multifact.mjs --prepare FRESH_PRIVATE_SEED PREPARED_DIR
# Complete the 40 development assessments in reviewTemplate.json; anchor DEV_REVIEW_DIGEST.
# Complete approval-template.json:
#   - calibration { mode: 'artifact', calibrationArtifactDigest: REGISTERED_D17_SET_DIGEST }
#   - the attested floors
#   - an approvalReference that cites DEV_REVIEW_DIGEST
# Anchor its digest.
# D17_CONTEXT.json: d17CalibrationRun (the sealed D17 c03 run), d17CalibrationDir (registered set),
#   d17CalibrationReviewFile, trustedD17CalibrationReviewDigest, d17DevelopmentReviewFile, trustedD17DevelopmentReviewDigest.
nice -n 19 node tools/decision/d17-multifact.mjs --bundle PREPARED_DIR APPROVAL.json DEV_REVIEW.json DEV_REVIEW_DIGEST BUNDLE.json D17_CONTEXT.json
nice -n 19 node tools/decision/d17-multifact.mjs --dry-run-ledger BUNDLE.json APPROVAL_DIGEST ARTIFACT_ROOT D17_CONTEXT.json
nice -n 19 node tools/decision/heldout-study.mjs --dry-run BUNDLE.json APPROVAL_DIGEST ARTIFACT_ROOT
AIWG_DECISION_HELDOUT_LIVE=1 nice -n 19 node tools/decision/heldout-study.mjs --collect-approved BUNDLE.json APPROVAL_DIGEST ARTIFACT_ROOT
# Resume each 30-minute checkpoint with a new run ID until complete.
nice -n 19 node tools/decision/d17-multifact.mjs --score SCORE_CONFIG.json SCORE.json
```

The score config names the run, gold and integrity files and the D17
calibration context keys, together with their trusted digests and
`evaluatedAt`.

## Remaining

- The live run, after independent review and operator go-ahead.
- The operator-delegated development review.
- The results summary.
