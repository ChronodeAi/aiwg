# Judge Validation Card

## Judge Surface

- System:
- Decision class:
- Judge model/provider:
- Judge prompt version:
- Rubric version:
- Parser version:
- Candidate artifact being judged:

## Validation Package

| Component | Path or owner | Protected from producer? | Version or hash | Notes |
|---|---|---|---|---|
| Calibration cases |  |  |  |  |
| Reference labels or adjudicator |  |  |  |  |
| Judge prompt |  |  |  |  |
| Rubric |  |  |  |  |
| Result parser |  |  |  |  |
| Thresholds/floors |  |  |  |  |
| Validation report |  |  |  |  |

## Metrics

| Metric | Value | Floor or band | Evidence |
|---|---:|---:|---|
| Raw agreement |  |  |  |
| Chance-corrected agreement |  |  |  |
| Test-retest consistency |  |  |  |
| Position-bias delta |  |  |  |
| Verbosity/style-bias delta |  |  |  |
| Refusal/format sensitivity |  |  |  |
| Cross-benchmark or task-family transfer |  |  |  |

## Required Questions

- Is exact-match agreement only diagnostic, never the sole promotion signal?
- Does the validation package match the same task family, rubric, and benchmark being judged?
- Can the producer edit the judge prompt, rubric, calibration cases, parser, thresholds, or validation
  report?
- Are answer positions randomized or swapped in the audit?
- Is high repeatability interpreted together with bias and validity checks?
- Is the verdict bound to the candidate artifact and judge-validation package?

## Verdict

- Status: `authoritative` / `advisory-only` / `blocked`
- Rationale:
- Required closures:
- Residual risk:
