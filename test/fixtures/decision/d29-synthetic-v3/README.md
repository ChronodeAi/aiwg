# D29 v3 public development demo

Experimental, default-off synthetic development data for #2622. Public seed:
`d29-study-v4`. **This is not a private holdout and is rejected for paid collection.**
All files contain authored fictional inputs or incomplete planning records;
there are zero provider observations and no completed human assessments.
The v1/v2 generators and the frozen visible-text baseline remain unchanged.
The retained v2 directory is historical, with its original source pins.

Reproduce the current counts, digests, shortcut audit and spend offline:

```bash
nice -n 19 node tools/decision/d29-study.mjs --dry-run d29-study-v4
```

- `corpus.json`: 2,000 registered v3 rows; 250 tuning, 250 calibration, 1,500 test.
- `gold.json`: separate versioned latent facts and oracle labels; never provider input.
- `analysis.json`, `preregistration.json`: frozen staged protocol and regeneration
  record (`priorLiveObservations: 0`).
- `reviews.json`: 50 development, 100 test and 15 delayed-repeat assessments,
  all blank. Five per slice maximize primary variant coverage; planned and
  wrong-attribute incomplete-criterion forms are absent from the 50.
- `approval-template.json`: incomplete calibration-phase approval. Test access
  requires a separate approval tied to a sealed phase and reviewed D09 artifact.
- `dry-run.json`: source-computed digests, every split/slice/variant count,
  deterministic baseline metrics, top-ten shortcut rules per target, and spend
  reservations. These are planning diagnostics, not live evaluation results.

The [study guide](../../../../docs/decision/d29-heldout-study.md) contains the
labeling rules, audit limits, complete variant counts, public-seed exclusions,
review requirements and approval text. A paid study needs a fresh private seed,
new operator review and independently anchored digests. Do not copy public demo
memberships into a paid study. Fixture provenance pins all files in
`../qualification-fixtures-v1.json`; the v3 test re-derives them from source.
