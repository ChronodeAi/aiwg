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

v2 was re-preregistered and re-frozen on 2026-09-30, before any v2 live score
existed; no Jev call has been made for v2. The earlier design required 1,816
live rows, which the operator's caps (USD 8.00 total and at most 600 items)
could not cover, and its 2,000-token per-call bound was below the measured
request size.

| Live split | Rows | Selection |
|---|---:|---|
| Calibration | 100 | CLINC150 validation rows, one per intent, 100 intents from a seeded order |
| Final test | 100 | CLINC150 test rows, one per intent, 100 intents from an independent seeded order |
| Controlled shift | 50 | Seeded CLINC150 `oos_test` rows |

Banking77 has no live subset. Its frozen rows and the larger frozen CLINC150
splits remain for synthetic pipeline tests only. Because only one task is
collected live, a passing live result is capped at `CONDITIONAL`.

Budget arithmetic: the largest measured Jev request body for the live subset is
4,779 bytes (151 options). Byte-level tokenizers emit at most one token per
byte, so the preregistered bound is 5,400 input tokens (4,779 bytes plus a
512-token server allowance) and 256 output tokens. At the pinned ceiling of
USD 5 per million input and output tokens, every call reserves USD 0.02828.
The 250-row subset therefore costs at most USD 7.07, leaving USD 0.93 (32
reservations) for retries. The server allowance, the output bound and the price
ceiling are assumptions. The collector halts at the first call whose charge
exceeds its reservation, and live mode requires the operator to attest the price
ceiling (`AIWG_DECISION_JEV_PRICE_CEILING_ATTESTED=5/5`).

Statistical rationale: with 100 calibration rows, split conformal gives marginal
coverage between 0.900 and 0.910. With 100 final-test rows, the 0.80 Wilson
lower-bound gate needs at least 88 of 100 rows covered. A method whose true
coverage is 0.90 passes with probability 0.80, one at 0.85 with probability
0.25, and one at 0.80 with probability 0.025. Terminal errors or missing
distributions above 5% of any live split make the outcome
`INSUFFICIENT EVIDENCE`.

## Live Collection Budget Rules

- Every call or retry durably reserves the worst case before dispatch. The
  collector refuses when the spend already recorded plus that reservation would
  exceed USD 8.00.
- Spend is global for the experiment state directory: the larger of a
  hash-chained, fsynced spend ledger and the sum of charges in every score file
  in the directory. It survives resumes, per-split outputs and deleted score
  files. A reservation that is never settled, for example after a crash, stays
  counted as spent.
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
- Each record carries collector provenance (collector version, request ID,
  usage, attempts and a record digest chained into the ledger). Records without
  verifiable provenance, including hand-written JSONL, cannot produce a
  `CONDITIONAL` or `GO` outcome.
- The calibrated-risk baseline is fitted on the same live calibration subset as
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
