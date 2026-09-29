# Conformal Prediction Spike

The #2613 conformal work is an experimental, default-off research spike. It does
not add production routing, action authorization, or acceptance-policy mutation.
Native decision evidence stays authoritative; conformal sets are separately
versioned derived artifacts.

## Implemented Offline

- `tools/experiments/conformal/preregister.v2.json` preregisters method, tasks,
  pins, splits, target coverage, usefulness gates, sample-size rationale,
  metrics and resource budget.
- `tools/experiments/conformal/fetch-open-data.mjs` downloads only canonical
  public CLINC150 and Banking77 raw files, verifies SHA-256, and writes the
  bounded `frozen.v2.json` sample. Raw files are not committed.
- `tools/experiments/conformal/run.v2.mjs` runs end-to-end against a
  deterministic synthetic-score stand-in and emits `INSUFFICIENT EVIDENCE`.
  With `--scores LIVE.jsonl`, it validates live score IDs, frozen split hashes,
  and compatibility keys before calculating the preregistered outcome.
- `tools/experiments/conformal/collect-jev.v2.mjs` is an opt-in live collection
  harness through `evaluateDecisionRuleset` and `JevDecisionAdapter`. Dry-run is
  the default; live mode requires the explicit smoke env gate, a credential, a
  declared region, the manifest item cap, and the USD 8.00 hard ceiling. It
  reserves the preregistered conservative per-call bound before each call or
  retry, writes fsync'd JSONL records as they complete, stops on repeated
  errors, and resumes by skipping completed IDs.
- `schemas/decision/ConformalPreregistration.v2.schema.json`,
  `ConformalFrozenOpenData.v2.schema.json`, and
  `ConformalOpenDataReport.v2.schema.json` define closed versioned contracts for
  the retained artifacts.

## Pending Evidence

The current result remains `INSUFFICIENT EVIDENCE`. A stronger outcome needs live
Jev scores or another approved representative score source, D10 projection and
egress approval, D14 metadata-only lineage and retention evidence, approved D09
calibrated-risk profiles, and D11 held-out qualification review. The v2 task set
contains Choice datasets only; Noul and Score semantics are not evaluated or
relabelled.

## Frozen Public Sources

The v2 sample records retrieval date `2026-09-29`, license metadata, byte
counts, and SHA-256 for every raw file. CLINC150's repository `LICENSE` is the
source of truth and is CC-BY-3.0, not CC-BY-4.0.

| Dataset | Source | SHA-256 | License |
|---|---|---|---|
| CLINC150 | `https://raw.githubusercontent.com/clinc/oos-eval/master/data/data_full.json` | `36923c3705a59e08fe9c3883d8bc2dd966ef93e22cb78ac41171782a698d56e0` | CC-BY-3.0; license file `https://raw.githubusercontent.com/clinc/oos-eval/master/LICENSE` sha256 `e6bc9e9c474700b708f568bac9e5a8a9bcb2b1dad53442f5ba449fcb848b8e76` |
| Banking77 train | `https://raw.githubusercontent.com/PolyAI-LDN/task-specific-datasets/master/banking_data/train.csv` | `b06e26ac675513959a63135f11b94ea7786ed02da65db93a5650d8838cbc664b` | CC-BY-4.0 |
| Banking77 test | `https://raw.githubusercontent.com/PolyAI-LDN/task-specific-datasets/master/banking_data/test.csv` | `d12d6e3bc4c3103966ae786dc435913c0c563dfa328f5a3646d0e62cfeeb474d` | CC-BY-4.0 |

Banking77 nominal train, calibration and final-test rows are sampled from
`train.csv`; the Banking77 shift slice comes from `test.csv`, so it is
source-separated from the nominal Banking77 splits. CLINC150 uses the in-scope
test split for nominal final-test rows and `oos_test` for the controlled OOD
slice. Per-class coverage is explicitly unsupported in v2 unless a class has at
least 50 rows.
