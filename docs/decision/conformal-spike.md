# Conformal Prediction Spike

The #2613 conformal work is an experimental, default-off research spike. It does
not add production routing, action authorization, or acceptance-policy mutation.
Native decision evidence stays authoritative; conformal sets are separately
versioned derived artifacts.

## Implemented Offline

- `tools/experiments/conformal/preregister.v2.json` preregisters method, tasks,
  pins, splits, target coverage, usefulness gates, the live sample design and its
  rationale, metrics and the resource budget.
- `tools/experiments/conformal/fetch-open-data.mjs` downloads only canonical
  public CLINC150 and Banking77 raw and licence files (or re-verifies them with
  `--offline`), checks every SHA-256, and writes the bounded `frozen.v2.json`
  sample with its preregistered live subsets. Raw files are not committed.
- `tools/experiments/conformal/run.v2.mjs` runs end-to-end against a
  deterministic synthetic-score stand-in over the full frozen splits (pipeline
  tests only) and emits `INSUFFICIENT EVIDENCE`. With `--scores LIVE.jsonl` it
  reads exactly the preregistered live subset and rejects any record outside it,
  any record whose compatibility key differs from the preregistered pins, and any
  success whose served model is not the pinned model.
- `tools/experiments/conformal/collect-jev.v2.mjs` is an opt-in live collection
  harness through `evaluateDecisionRuleset` and `JevDecisionAdapter`. It is
  dry-run by default. The budget rules are listed below.
- `schemas/decision/ConformalPreregistration.v2.schema.json`,
  `ConformalFrozenOpenData.v2.schema.json`, and
  `ConformalOpenDataReport.v2.schema.json` are closed, versioned contracts. The
  report's `integrity` block lists the #2037/#2048 fields explicitly and permits
  no other keys.

## Live Sample Design (re-preregistered 2026-09-30)

v2 was re-preregistered and re-frozen on 2026-09-30. No v2 live score existed at
re-pin time, and no Jev call has been made for v2 collection. The operator
restored the full two-dataset design and re-pinned the price ceiling.

| Task | Calibration | Final test | Shift split |
|---|---:|---:|---|
| CLINC150 | 450 | 450 | 300 controlled OOS rows (`oos_test`, a label never seen in calibration) |
| Banking77 | 231 | 231 | 154 `test.csv` rows: a nominal held-out slice, **not** a shift |

The live sample is every frozen calibration, final-test and shift row: 1,816
items under a preregistered 2,000-item cap. The 1,135 frozen train rows are not
collected live.

**Pricing and worst-case cost.** Published Jev pricing is USD 0.042 per million
input tokens with output free
([eesel.ai](https://www.eesel.ai/blog/typesafe-jev-pricing),
[MindStudio](https://www.mindstudio.ai/blog/jev-pricing-cost-per-token)). An
operator smoke call on 2026-09-30 returned 369 input and 38 output tokens,
served model `jev-1.13.0` and `costUsd: null`. The pinned ceiling is USD 0.10
per million tokens for both input and output, about 2.4 times the published
input price. The largest measured request body across the 1,816 live rows is
4,796 bytes (the 151-option CLINC150 prompt). Byte-level tokenizers emit at most
one token per byte, so the per-call bound is 5,400 input tokens (4,796 bytes
plus a 512-token server allowance) and 256 output tokens. Each call reserves
5,656 tokens × USD 0.10 per million = USD 0.0005656, rounded up to 566 micro-USD.
The design's worst case is 1,816 × 566 = 1,027,856 micro-USD, which is
**USD 1.027856** (USD 1.0271296 before per-call rounding). That is well inside
the unchanged USD 8.00 hard cap.

**Assumptions.** The Jev request contract (`{state, model, questions}`) has no
output-token cap, so the 256-token output bound is an assumed server-side bound,
like the 512-token server allowance. A call reporting more is charged in full,
and the ledger halts. Live mode requires
`AIWG_DECISION_JEV_PRICE_CEILING_ATTESTED=0.10/0.10`.

**Gates.** Split conformal with 450 (CLINC150) or 231 (Banking77) calibration
rows gives marginal coverage between 0.900 and 0.902 or 0.904. The coverage
gate is a 95% Wilson lower bound of at least 0.83, computed on the realized
scored n of each split, so the covered count it requires depends on n. The
preregistration's `liveDesign.gateTable` lists it at full size and at the 5%
failure-tolerance floor:

| Split | Scored n | Covered rows needed | P(pass), true coverage 0.90 | P(pass), true coverage 0.85 |
|---|---:|---:|---:|---:|
| CLINC150 final | 450 / 428 | 390 / 371 | 0.991 / 0.989 | 0.178 / 0.183 |
| CLINC150 OOS shift | 300 / 285 | 262 / 249 | 0.945 / 0.939 | 0.146 / 0.149 |
| Banking77 final | 231 / 220 | 203 / 194 | 0.880 / 0.844 | 0.127 / 0.107 |
| Banking77 held-out | 154 / 147 | 137 / 131 | 0.722 / 0.699 | 0.100 / 0.096 |

These are binomial pass probabilities and ignore variance from the calibration
draw. A split has enough rows when at least max(floor, ceil(0.95 × its size))
rows are scored. The floors are 200 final-test rows and 50 slice rows. Terminal
errors or missing distributions above 5% of any live split make the outcome
`INSUFFICIENT EVIDENCE`. Other usefulness gates are unchanged: mean set size at
most 8% of the labels, review at most 45%, selective risk at most 0.12, and
improvement over the live calibrated-risk baseline. `GO` needs both tasks to
pass on final test and on their shift split. The CLINC150 OOS slice is the only
controlled shift, so AC5 rests on it alone.

## Live Collection Budget Rules

- Every call or retry durably reserves the worst case before dispatch. The
  collector refuses when spend already recorded plus that reservation would
  exceed USD 8.00.
- Spend is global for the experiment state directory: the larger of a
  hash-chained, fsynced spend ledger and the sum of charges in every score file
  in the directory. It survives resumes, per-split outputs and deleted score
  files. A reservation that is never settled, for example after a crash, stays
  counted as spent and counts as an attempt. Reservation IDs are unique.
- The state directory is the budget's identity. Empty `XDG_STATE_HOME` or
  `HOME` values count as unset, the directory must be absolute, and live runs
  refuse volatile locations (`/tmp`, `/var/tmp`, `/dev/shm`, `/run`, the OS
  temp directory). With neither variable set, pass an absolute `--state-dir`.
- Planning and `--limit` cover only pending rows: rows that are not yet
  terminal and still have attempts left. A resume after partial spend, or after
  a stop on three consecutive errors, continues with the next pending rows. The
  per-call reservation guard, not the plan, is what enforces the ceiling.
- Charges use reported tokens at the pinned price ceiling, or a higher reported
  provider cost. When tokens are unknown, the call is charged the full
  reservation. A charge above its reservation halts the ledger, and later runs
  refuse to call.
- Only the pinned model (`jev-1.13.0`), adapter, prompt digest and collector
  code digest may be used. The collector refuses a different `--model` and
  refuses to resume into a score file whose records carry a different
  compatibility key.
- A success without a native distribution is recorded as `missing-distribution`
  with no probabilities. It is never turned into one-hot probabilities.
- Error records are retried on resume, up to three attempts per item. A single
  truncated trailing line is moved to `<file>.quarantine` and resume continues.
- A record is representative only if it carries collector provenance and passes
  every ledger check:
  - its attempts match, one to one, the reserve and settle entries for that
    item;
  - its charges equal the settlements;
  - its record digest is chained into the ledger;
  - every entry it references carries this preregistration's hash;
  - its request ID is non-empty and unique among success records.

  Records that fail, including hand-written or re-chained JSONL, cannot produce
  a `CONDITIONAL` or `GO` outcome. The chain is tamper-evident, not
  cryptographically authenticated: nobody signs it, so someone with write access
  to the state directory could still forge a full ledger.
- The calibrated-risk baseline is fitted on the same live calibration split as
  the conformal threshold, so `baselineImprovement` compares live against live.

## Pending Evidence

The current result remains `INSUFFICIENT EVIDENCE`. A stronger outcome needs an
operator-approved live run within the budget above, D10 projection and egress
approval, D14 metadata-only lineage and retention evidence, approved D09
calibrated-risk profiles, and D11 held-out qualification review. The v2 task set
contains Choice datasets only; Noul and Score semantics are not evaluated or
relabelled.

## Frozen Public Sources

The v2 sample records retrieval date `2026-09-29`, license metadata, byte
counts, and SHA-256 for every raw file and licence file (licence files verified
2026-09-30). CLINC150's repository `LICENSE` is CC-BY-3.0, not CC-BY-4.0.

| Dataset | Source | SHA-256 | License |
|---|---|---|---|
| CLINC150 | `https://raw.githubusercontent.com/clinc/oos-eval/master/data/data_full.json` | `36923c3705a59e08fe9c3883d8bc2dd966ef93e22cb78ac41171782a698d56e0` | CC-BY-3.0; licence file `https://raw.githubusercontent.com/clinc/oos-eval/master/LICENSE` sha256 `e6bc9e9c474700b708f568bac9e5a8a9bcb2b1dad53442f5ba449fcb848b8e76` |
| Banking77 train | `https://raw.githubusercontent.com/PolyAI-LDN/task-specific-datasets/master/banking_data/train.csv` | `b06e26ac675513959a63135f11b94ea7786ed02da65db93a5650d8838cbc664b` | CC-BY-4.0; licence file `https://raw.githubusercontent.com/PolyAI-LDN/task-specific-datasets/master/LICENSE` sha256 `7e7170e3cebf88a9f60c7b8421418323c09304da1af4d5e90f4da1dc1c8a2661` |
| Banking77 test | `https://raw.githubusercontent.com/PolyAI-LDN/task-specific-datasets/master/banking_data/test.csv` | `d12d6e3bc4c3103966ae786dc435913c0c563dfa328f5a3646d0e62cfeeb474d` | CC-BY-4.0; same licence file |

Banking77 nominal train, calibration and final-test rows are sampled from
`train.csv`. Its `test.csv` rows are a nominal held-out slice: `train.csv` and
`test.csv` are a random split of one collection, so the rows are exchangeable
and are **not** a distribution shift. The controlled distribution-shift evidence
for AC5 rests on CLINC150 `oos_test` only. The re-freeze left the train,
calibration and final-test split hashes unchanged; the shift split hash changed
only because of that slice relabel. Per-class coverage is unsupported.
