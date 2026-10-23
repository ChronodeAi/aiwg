# Rule probes and release comparison

`release-compare.mjs` compares paired baseline (A) and candidate (B) responses.
See the [complete usage guide](../../docs/contributing/release-comparison.md) and
[release validation checklist](../../docs/contributing/release-validation-procedure.md).

The per-scenario decision rule is:

1. Any A-passed/B-failed pair or lower B assertion pass rate is a hard regression.
2. Exclude ties from judge wins. With `a` A wins and `b` B wins, regression requires
   the one-sided exact sign-test probability `P(X >= a | X ~ Binomial(a+b, 0.5))`
   to be **below** `--judge-alpha` (default `0.05`). At n=5, only 5 A wins and
   no B wins meet this threshold (`p=0.03125`); 4/1 gives `p=0.1875`.
3. Any dimension mean drop **greater than** `--judge-score-margin` is a regression.
   The default is `1.0`, one point on the judge's integer 0–4 scale.
4. Mirror these tests for improvement. If both directions trigger, regression wins.
   Otherwise the scenario is unchanged. Invalid or incomplete evidence holds the gate.

Flags accept `0 < judge-alpha < 1` and `0 <= judge-score-margin <= 4`.
Programmatic callers pass `judgeAlpha` and `judgeScoreMargin` to `comparisonPlan`.
Plans and JSON reports retain them as `judge_alpha` and `judge_score_margin`.
Freeze thresholds before a comparison; release evidence verification requires the
report to match the trusted plan (the quarterly release producer uses defaults).

JSON and Markdown report A/B/tie tallies, both directional sign-test p-values,
dimension mean deltas (B minus A), the maximum absolute dimension delta, and the
decision rule plus all triggered rules. JSON retains every pair's mapped winner
and scores; Markdown also shows per-pair dimension deltas. Ties contribute to
dimension means but not to the sign test. With no non-tie wins, both p-values are 1.
