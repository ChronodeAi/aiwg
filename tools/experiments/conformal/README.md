# Conformal decision spike (#2613)

## Open-data v2

`preregister.v2.json`, `frozen.v2.json`, `open-data.mjs`, `fetch-open-data.mjs`,
`run.v2.mjs`, and `collect-jev.v2.mjs` are the second experiment version. They
replace the missing internal D11 data with public CLINC150 and Banking77 samples.
The raw files are not committed; `fetch-open-data.mjs` deterministically downloads
the canonical public data and licence files (or re-verifies them with
`--offline`), verifies their SHA-256 values, records URL, license, licence hash,
retrieval date and byte count, and writes a bounded stratified sample plus the
preregistered live subsets.

```bash
node tools/experiments/conformal/fetch-open-data.mjs \
  --raw-dir /tmp/aiwg-2613-open-data \
  --output tools/experiments/conformal/frozen.v2.json \
  --retrieval-date 2026-09-29
node --import tsx tools/experiments/conformal/run.v2.mjs ARTIFACT_ROOT/research/reports/conformal-2613-v2
node --import tsx tools/experiments/conformal/collect-jev.v2.mjs --limit 25
```

The frozen splits (1,135 train, 681 calibration, 681 final-test and 454 shift
rows) are for synthetic pipeline tests only. The live design, re-preregistered
on 2026-09-30 before any live score existed, is a 250-row CLINC150 subset: 100
calibration and 100 final-test rows (one per intent) plus 50 controlled OOS
rows. At USD 0.02828 worst case per call, it costs at most USD 7.07 of the
USD 8.00 cap. Banking77 is not collected live, so a passing live outcome is
capped at `CONDITIONAL`. Banking77 `test.csv` rows are an exchangeable nominal
held-out slice, not a shift. See `docs/decision/conformal-spike.md` for the
sizing rationale.

The collector is dry-run by default. Live mode requires
`AIWG_DECISION_JEV_LIVE_SMOKE=1`, `AIWG_DECISION_JEV_API_KEY`,
`AIWG_DECISION_JEV_REGION` and `AIWG_DECISION_JEV_PRICE_CEILING_ATTESTED=5/5`,
and only the pinned model `jev-1.13.0`. Before every call it reserves the
worst-case cost in a hash-chained spend ledger shared by every run in the state
directory (`$XDG_STATE_HOME/aiwg/conformal-2613/` or
`$HOME/.local/state/aiwg/conformal-2613/`, not inside the repository). It
refuses any call that could take global spend past USD 8.00 and halts on the
first charge above its reservation. It charges reported tokens at the pinned
price ceiling, or the full reservation when usage is unknown. It records
distribution-less successes as `missing-distribution`, retries error records on
resume, and quarantines a truncated trailing line. A lock file prevents two
concurrent collectors in one state directory. The analysis accepts only records
whose compatibility key matches the preregistered pins. Records without collector
provenance chained into the ledger cannot leave `INSUFFICIENT EVIDENCE`.

Closed schemas for the v2 preregistration, frozen sample and report live under
`schemas/decision/Conformal*.v2.schema.json`.

## Synthetic v1

**Outcome: INSUFFICIENT EVIDENCE.** This offline experiment establishes a reproducible
arithmetic and compatibility prototype. It does not establish representative Choice
or Noul workload performance, nor production support. There is no action executor,
CLI registration, MCP registration, or acceptance-policy mutation in this directory.

The protocol was signed in commit `fbddd386c` before the frozen rows and prototype
were signed in `490bbee79`, before final-test evaluation. The final runner adds
reporting and pure baseline replay. No thresholds, split membership, labels, scores,
or method were changed after the initial evaluation. The subsequent deterministic
replay test found an order-sensitive report digest; the runner now captures the
immutable input digest before perturbing completion order. Timings are kept in a
separate file because elapsed time cannot be byte-identical across runs.

Run from the repository root after installing its normal development dependencies:

```bash
node --test tools/experiments/conformal/prototype.test.mjs
aiwg artifacts path --json --check-write
# Replace ARTIFACT_ROOT with the returned artifact_root, not an assumed .aiwg path.
node --import tsx tools/experiments/conformal/run.mjs ARTIFACT_ROOT/research/reports/conformal-2613
```

The runner creates `report.json` (all metrics and provenance), `per-example.jsonl`
(native evidence digest plus derived sets), `plots.svg` (risk/acceptance, reliability,
set-size frequency), and `timing.json` (local mean/p95 latency). Only generated
public synthetic records are included. No secrets, prompts, state snapshots, human
labels, provider credentials, network requests, or live calls are used. Tests run
replay with only PATH inherited and reject restricted/provider-backed/held/deleted
records. Lifecycle failures reject the entire input; rows are never silently dropped.
There is no live option: live absence is explicitly `not-performed`.

## Study and result

One method, `lac-v1`, uses nonconformity `1-p(y)` with split-conformal rank
`ceil((n+1)*(1-alpha))` at alpha 0.1. Insufficient calibration yields the full set;
boundary ties are included without randomization. Empty sets also defer. A singleton
is counted as a hypothetical auto decision only for loss measurement. It authorizes
nothing. Choice remains a full relative distribution. Noul retains its original
`yesProbability`; the derived binary vector is `[1-P(yes), P(yes)]`, never confidence.
Compatibility one-hot LLM observations are rejected by provenance.

Tasks describe bounded issue routing (bug/docs/feature) and whether a change needs
review (no/yes). These names do **not** make generated records representative of
actual workflows. Each task has 300 tuning, 300 calibration, 600 test and 600 shift
rows. All entities are unique and splits have separate deterministic PRNG streams.
The controlled shift reverses the label distribution while leaving predictions
unchanged. It intentionally violates exchangeability; this is a failure illustration,
not a robustness theorem or a model-drift detector.

| Task / slice | LAC coverage (95% Wilson interval) | Mean size | p50/p90/p95 | Review | Selective risk | False-auto |
|---|---:|---:|---|---:|---:|---:|
| Choice / test | 89.83% (87.16–92.00%) | 1.188 | 1 / 2 / 2 | 18.83% | 10.27% | 8.33% |
| Choice / shift | 12.83% (10.39–15.75%) | 1.187 | 1 / 2 / 2 | 18.67% | 95.29% | 77.50% |
| Noul / test | 96.17% (94.31–97.43%) | 1.173 | 1 / 2 / 2 | 17.33% | 4.64% | 3.83% |
| Noul / shift | 24.00% (20.75–27.58%) | 1.213 | 1 / 2 / 2 | 21.33% | 96.61% | 76.00% |

The raw baseline calls the existing `applyPrimitiveAcceptance` engine: selected
Choice probability >=0.8 and Noul P(yes) <=0.2 or >=0.8. On both nominal tasks, LAC
has exactly the same singleton risk and review load as that raw baseline. It adds
sets on deferred rows, not an improved risk/review tradeoff.

The calibrated-risk comparison also calls that engine, using tuning-only top-score
bins and their 95% Wilson error upper bounds at a 0.1 risk threshold. Choice reviews
all 600 test rows (selective risk undefined); Noul matches the raw baseline. This is
an explicit synthetic estimate, **not an approved D09 calibration profile**. The
existing D11 split verifier checks tuning/calibration/test membership, with additional
prototype checks for entity overlap and shift membership. An actual D09/D11 workload
comparison remains an external evidence gap.

Always-review has 100% review, zero false-auto and undefined selective risk.
Always-predict has 17.83% Choice and 11.17% Noul test risk. Full baseline/class/stratum
results are in JSON. Set coverage counts only emitted sets: an empty review output
has zero set coverage, not an assumed correct human decision. Selective risk divides
wrong singletons by singletons; false-auto divides by all rows. Unit review cost is
the number of nonsingletons. Every class/stratum reports n and intervals; n<50 is
marked unsupported. Marginal guarantees do not establish class-conditional coverage.

Calls, input/output tokens, and provider USD are exactly zero. Timing measures only
local method evaluation, not provider latency or real reviewer cost. The theoretical
sample-size calculation is about +/-2.4 percentage points for 600 independent rows
at 90% coverage, not a power claim about real workload benefit. The preregistered
85% Wilson lower-bound diagnostic is not proof of achieving 90% population coverage.
Choice also narrowly fails the preregistered 10% point-risk ceiling, while both shift
slices fail coverage and risk. No synthetic gate can override the data shortfall.

## Provenance and compatibility

Canonical JSON SHA-256 hashes cover full rows including native evidence and labels;
split membership and entity uniqueness are validated before scoring. These are
content hashes, not hashes of pretty-printed file bytes. The initial frozen corpus is
stored in `frozen.json`; `freeze.mjs` regenerates it for verification, never silently
replaces a study manifest during evaluation.

| Split | SHA-256 (canonical ordered rows) |
|---|---|
| tuning | `7bbb9aab1000c27781ab86f2a38351570b6bbf5ccaec7d3139e667904ddd9f6e` |
| calibration | `40433b98f5e94f30dec5f41b3c0228ffcc86ce6c11fd5884489125c866fa5268` |
| test | `cc1127152d5fe949eb83ff7796e6b345047d228f32ebe8269485ff793367ac87` |
| shift | `9b6d290629d05c5aba5c03c9e588468c68f34ba091e7cb44718167c13fdf563b` |

Each separately versioned derived profile keys served model, primitive/task,
definition digest, adapter, dataset population, nonconformity method, calibration
split digest, prototype code digest and alpha. Any key change rejects reuse. The
runner records its own digest and source manifests separately. Native rows are never
overwritten. These offline helper functions operate only behind the frozen-input
hash check; they are not a general untrusted-data admission boundary.

The report calls the existing #2037/#2048 `buildIntegrityMetadata` serializer and
adds a `conformal-evidence/v1` extension. It retains `sample_n`, uncertainty,
paired-baseline, integrity mode/freshness/state/trusted-source/compromise/weak-signal
fields and release gate reasons. This run is unverified and non-promotable; method
evidence cannot upgrade HOLD or ROLLBACK. No fresh locked workspace is claimed.

## Questions answered and remaining evidence

Choice can mechanically produce sets; usefulness on representative data is unknown.
Noul can mechanically produce a deferral band: include yes when P(yes)>=1-q and no
when P(yes)<=q; defer whenever cardinality differs from one. Probability retains its
native semantics. Score is not evaluated: an ordered set can be disconnected, and
neither absolute-level error nor a contiguous interval has a validated action loss
for this workload. Do not transfer Choice guarantees to Score.

Before attaching a conformal profile to an acceptance policy, obtain frozen,
independently labeled representative Choice/Noul task data (at least 600 test rows
per task and 50 per reported class/slice under this protocol), approved immutable
D09 calibrated-risk profiles, a real D11 held-out comparison, supported sampling and
entity independence assumptions, and an independently verified integrity snapshot.
Any later live collection additionally needs explicit budget approval, D10 field
projection/provider/model/region/purpose authorization, and D14 metadata-only lineage,
retention/deletion/backup/legal-hold handling. Such collection must be a separate
preregistered study. Current helpers reject all non-active rows; they do not implement
the production lifecycle or claim coverage of live-policy integration.

There is no positive implementation proposal because there is no positive outcome.
The next work is acquisition and independent validation of those missing inputs,
followed by a new frozen protocol; no default-off production feature is added here.

## Acceptance/evidence map

| Criterion | Evidence and limits |
|---|---|
| AC1 preregistration | Signed protocol commit, `preregister.json`; all methods/pins/gates/budgets frozen before evaluation |
| AC2 disjoint immutable splits | `frozen.json`, split hashes above, CONF-01 and D11 verifier |
| AC3 isolation | Only `tools/experiments/conformal`; no registration/executor; `authorization:false` |
| AC4 metrics | JSON, JSONL, SVG and timings emitted by runner; table above; CONF-06 |
| AC5 shift | Label-reversal slice and severe observed coverage degradation; CONF-08 |
| AC6 native semantics | Retained distributions and P(yes), one-hot provenance rejection; CONF-03/05; Score excluded |
| AC7 compatibility | Exact tuple comparison and mutation of every dimension; CONF-04 |
| AC8 single outcome | INSUFFICIENT EVIDENCE from missing representative and approved calibration inputs |
| AC9 positive follow-up | Not applicable to insufficient evidence; no production feature |
| AC10 offline | No external credentials or calls, subprocess restricted environment; CONF-05/08 |
| AC11 integrity | Existing serializer plus versioned extension; non-upgrade tests CONF-07 |
| Real/workflow comparison | **Missing** representative frozen D11 distributions and approved D09 profiles |
| Live lifecycle amendment | Offline-only rejection tests; production D10/D14 collection is **not performed** |

## Original research

- [Sadinle, Lei and Wasserman, Least Ambiguous Set-Valued Classifiers (2019), §4.3](https://arxiv.org/html/1609.00451v2): probability-level sets with split-conformal adjustment. The selected simple inverse-probability score follows this approach; conservative ties avoid randomization. This method source was verified during implementation; it does not change the frozen score definition.
- [Romano, Sesia and Candès, Classification with Valid and Adaptive Coverage (2020)](https://arxiv.org/abs/2006.02544v1): adaptive prediction sets are a possible alternative, excluded to keep one interpretable baseline and avoid post-holdout method selection.
- [Quach et al., Conformal Language Modeling (ICLR 2024)](https://arxiv.org/abs/2306.10193v2): original motivation for calibrated generation stopping/rejection. Those generative mechanisms are not the bounded classification method implemented here.

Source applicability: the original methodological studies support their stated
statistical assumptions, not this synthetic corpus's representativeness. Evidence
quality for a production AIWG recommendation is VERY LOW due to indirectness and
missing representative data. No synthetic performance is attributed to Jev.
