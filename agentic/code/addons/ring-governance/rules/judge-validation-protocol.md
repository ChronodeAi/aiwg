# Judge Validation Protocol

**Enforcement Level**: HIGH
**Scope**: LLM-as-judge evaluators, rubric reviewers, comparative graders, synthetic judges,
model-scored benchmarks, adjudication prompts, result parsers, and judge calibration reports.
**Addon**: ring-governance
**Status**: DRAFT

## Rule

An LLM-as-judge result must not be treated as governance proof unless the judge has a current
validation package for the task family being judged. Exact-match agreement with a reference label,
another judge, or a prior run is not sufficient.

## Research Basis

The 2026 paper "Reliability without Validity" reports that exact-match agreement can overstate judge
quality because it does not correct for chance; judge rankings can shift across benchmarks; high
test-retest reliability can coexist with position bias; and low verbosity bias under one rubric does
not prove absence of other bias. Governance should therefore validate the judge, not merely isolate it.

## Minimum Viable Validation

- **Chance-corrected agreement**: report Cohen's kappa or another declared chance-corrected agreement
  statistic next to raw agreement.
- **Test-retest consistency**: rerun the same cases under controlled conditions and report stability.
- **Position-bias audit**: swap answer order or presentation order and report the changed verdict rate.
- **Task-family transfer**: validate on the benchmark, rubric, and task class where the judge will be
  used; do not reuse a validation from a materially different benchmark as proof.
- **Bias audit scope**: include known relevant biases such as position, verbosity, style, provider,
  refusal, and format sensitivity; document omitted bias classes as residual risk.
- **Protected validation package**: keep prompts, rubrics, calibration cases, answer keys, parsers,
  thresholds, and validation reports outside the producer's edit surface.
- **Artifact binding**: bind each judge verdict to the candidate artifact, judge version, rubric
  version, prompt version, calibration set, and parser version.

## Required Controls

- Raw agreement may be logged as a diagnostic, but it must not be the only arming, promotion, or
  acceptance signal.
- High repeatability must not clear a gate by itself; a repeatable biased judge is still unsafe.
- Judge thresholds must be declared before use and changed only through governance review.
- A judge that fails its validation floor may still provide advisory feedback, but its verdict must be
  labeled non-authoritative.
- If the candidate can edit the judge prompt, rubric, calibration corpus, position-randomization logic,
  result parser, or validation thresholds, the judge is self-grading.

## Failure Smell

A governance gate says "the LLM judge agreed" but cannot show chance-corrected agreement, retest
results, position-bias results, and protected calibration artifacts for the exact decision class.
