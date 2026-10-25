# Sourced Jev pricing

AIWG uses one pricing configuration: `decision.ask.cost.*`. An explicit refresh
reads the [official TypeSafe model documentation](https://docs.typesafe.ai/models.md)
and writes validated, versioned Jev rates through the existing project config
writer. There is no independent pricing cache. Ordinary `decision ask` does not
fetch pricing documentation; history, stats and plain pricing display are offline.

```bash
aiwg decision pricing                            # current effective weights/provenance
aiwg decision pricing --refresh --model jev-1.13.0 --dry-run --json
aiwg decision pricing --refresh --model jev-1.13.0
aiwg decision pricing --refresh                   # reuse configured model version
```

The first refresh requires `--model jev-X.Y.Z`. Unknown versions fail without
writing. `--dry-run` fetches and validates normally, then shows each changed key's
old/new value without creating or changing config. All inputs have flags and the
command never prompts, including in headless environments. Invalid flags and
missing flag values are usage errors.

A successful refresh sets these keys:

| Key under `decision.ask.cost` | Meaning |
| --- | --- |
| `jev_input_per_mtok` | USD per million input tokens |
| `jev_output_per_mtok` | USD per million output tokens, including explicit zero |
| `source` | `typesafe-docs`, `typesafe-snapshot`, or `manual` |
| `checked_at` | ISO calendar date, YYYY-MM-DD |
| `jev_model` | Exact version the rates apply to |

`llm_per_mtok`, `jev_per_mtok`, caller assumptions, and unrelated project
configuration are preserved. Split rates and blended weights must be finite
numbers between zero and 1,000,000. You can set manual rates with the normal
`aiwg config set --project decision.ask.cost.<key> <value>` command. Mark their
source `manual` and provide their date and applicable version.

The fetch accepts at most 256 KiB and has a five-second timeout covering the body
read. It uses no credentials, refuses redirects, and never calls a model. The
parser requires versioned model IDs, matching billion/million units, finite
nonnegative prices, and an explicit free-output statement. Changed formats fail
closed and leave config unchanged.

## Explicit offline fallback

The bundled snapshot was checked **2026-10-18** and contains Jev 1.13.0 and
1.14.0 at $0.042 per million input tokens and $0 per million output tokens.
This is dated reference data, not a claim of current pricing.

```bash
# No network; explicitly select the bundled snapshot:
aiwg decision pricing --refresh --offline --model jev-1.13.0
# Try the documentation; permit the snapshot if fetching/parsing fails:
aiwg decision pricing --refresh --allow-snapshot --model jev-1.13.0
```

Snapshot use always records `source: typesafe-snapshot`, retains `checked_at:
2026-10-18`, and displays the snapshot date. A failed live refresh without
`--allow-snapshot` leaves config untouched. No implicit fallback occurs. Offline
and dry-run flags require `--refresh`.

## Cost precedence and recorded history

A complete input/output split pair takes precedence over `jev_per_mtok` when
recorded usage supplies the required components. Unknown output usage can be
priced when its configured rate is zero. Otherwise AIWG uses the existing blended
weight and counts missing usage components as zero, preserving previous behavior.
An incomplete split pair falls back to blended pricing. Remove both split keys
with `aiwg config reset --project <key>` to restore blended-only estimates.

New ledger records preserve the configured weights, provenance and chosen
`jev_rate_basis` in `estimationMethod`. Config changes do not reprice existing v2
records. Stats adds `ratesUsed`, with method and call count, alongside the existing
`llm_tokens_avoided`, `jev_tokens`, `cost_weighted_net_usd` and v1 comparison fields.
Old v1 records keep their existing in-memory re-estimation behavior and are never
rewritten. Old v2 records without provenance remain readable.

Select a pricing version matching the Jev backend you run. `jev_model` describes
the rates' applicability; the ledger separately records the actual response model.
The net figure still uses heuristic avoided caller tokens and configured LLM
weights. Sourced Jev rates improve its cost basis but do not establish exact invoice
savings. Missing token usage and cached billing can limit precision. See the
[quickstart savings section](jev-quickstart.md#reading-savings-and-setting-weights)
for caller assumptions and legacy reporting.

## Opt-in live paired collection

Build the CLI first. Supply credentials in the caller environment at run time:
`JEV_API_KEY` (or `AIWG_DECISION_JEV_API_KEY`) and `OPENAI_API_KEY`. The benchmark
reads no credential or token files. The default baseline uses the Responses API,
with tools disabled, no stored response and no retries. Library callers inject a
baseline client; tests inject both clients and the clock.

```bash
npm run build:cli
node tools/decision/benchmark.mjs --live --max-calls 24 --max-usd 1 \
  --dataset test/fixtures/decision/benchmark-smoke.json --capture captures/paired.json \
  --passes 3 --baseline-model <model-version> --baseline-price captures/baseline-rate.json --json
node tools/decision/benchmark.mjs --replay captures/paired.json --json
node tools/decision/benchmark.mjs --live --max-calls 12 --max-usd 2 \
  --extend captures/paired.json --passes 5 --json
```

Create the output directory before collection. New captures refuse to overwrite
existing files; `--extend` appends observations in place, using atomic checkpoints.
It also accepts a separate `--capture` destination. Source captures remain values
only; no paths or code from their contents are executed. Existing standalone
captures still accept `--dataset`.

Both `--max-calls` and a positive `--max-usd` are mandatory with `--live`. The call
cap must cover all missing observations before any provider runs. Each Jev
observation explicitly requests one ask pass with no escalation; each case gets
one independent baseline call. Extension reuses existing baselines and Jev
prefixes, calls only missing observations, and refuses a smaller pass count or
changed dataset, split or baseline label. It never triggers a baseline when all
baseline observations are already present.

To compare a new baseline using saved Jev responses, use `--jev-capture` with a
new output path and baseline settings:

```bash
node tools/decision/benchmark.mjs --live --max-calls 6 --max-usd 1 \
  --jev-capture captures/paired.json --capture captures/new-baseline.json \
  --passes 3 --baseline-model <new-model-version> --baseline-price captures/new-baseline-rate.json --json
```

The source accepts the same envelope or standalone capture with `--dataset` as
replay. Its schema and dataset digest (including the deterministic split) must
validate, and every case must have exactly the requested pass count. Mismatches
are refused before any provider call. Retain the same `--holdout` and `--seed`
for a custom split. Reuse requires `--live` and cannot combine with `--extend`
or replay. The source remains unchanged; the new capture preserves its Jev
answers, usage, latency and recorded costs alongside the new baseline. No Jev
credential or Jev call is needed. Only new baseline calls and their spend count
against `--max-calls` and `--max-usd`; historical costs remain available to the
offline analyzer. For the six-case example, the call cap is six. The resulting
capture replays with the same offline commands as any paired capture.

Collection stops before another call once recorded spend reaches 80% of the USD
cap. A request already in flight can cross that threshold, so this is a stop based
on reported usage, not an invoice ceiling. Extension includes all prior recorded
spend against its USD cap; `max-calls` counts new calls. Unknown served versions,
usage or billing produce a null cost and stop further calls. Unpriced captures
cannot be safely extended. Interrupted captures contain only real observations,
including a baseline without Jev passes if that is where collection stopped.
They validate as checkpoints; analysis requires complete observations for every
case at each requested pass count. Increase the USD cap to resume a priced
interrupted capture. If baseline rows are still missing, also supply the original
`--baseline-model`, `--baseline-effort` and `--baseline-price` settings.

Live collection always uses `splitBenchmarkHoldout`, default fraction `0.3` and
seed `3291`, before invoking either client. Both arms receive the same question,
mode and context; neither receives gold labels or split assignments. Retain the
same `--holdout` and `--seed` when extending a custom split. Only tuning cases
select a policy; holdout cases assess it afterward.

Each observation records the served model, token counts, measured latency,
answered/fallback status and `cost: {usd, price}`. A known price includes the
exact model, HTTPS source, checked date and existing `TokenPrice` fields. Jev
uses complete sourced rates from `decision.ask.cost.*` when configured, otherwise
the dated bundled TypeSafe snapshot. An unrecognized served version stays
unknown. Supply baseline rates explicitly in a JSON file such as:

```json
{
  "model": "exact-served-model-version",
  "source": "https://provider.example/pricing",
  "checkedAt": "2026-10-25",
  "inputPerMillionUsd": 2,
  "outputPerMillionUsd": 4,
  "cachedInputPerMillionUsd": 1
}
```

Those numbers are synthetic examples; replace them with verified provider rates.
Cache-aware billing requires reported cached-input counts. Missing billable
usage is unknown, even when all rates are zero. Captures preserve their sourced
costs for offline replay regardless of later project config changes. Optional
`collection` metadata records the stop reason, new call count and known USD
subtotal. Legacy captures remain readable with the existing config-based pricing. Extension
can price their historical observations using supplied sourced rates; missing
billable usage or matching rates still prevents extension.
No live pricing refresh or production policy change occurs.

## Offline paired benchmark analysis

The benchmark tool analyzes saved observations offline and supports explicit, bounded
paired collection. Offline modes make no provider calls and write no capture or
config. Ordinary `decision ask` never runs a baseline.

```bash
npm run build:cli
node tools/decision/benchmark.mjs analyze --capture captures/paired.json --json
# A draft-style capture with a separate labeled dataset:
node tools/decision/benchmark.mjs replay --capture captures/observations.json \
  --dataset test/fixtures/decision/benchmark-smoke.json --json
node tools/decision/benchmark.mjs analyze --capture captures/paired.json \
  --holdout 0.3 --seed experiment-1 --pass-counts 1,3,5 \
  --thresholds 0.7,0.8,0.9 --agreement 0.67 \
  --minimum-accuracy 1 --maximum-fallback-rate 0.5
```

All inputs have flags; missing inputs and unknown flags fail without prompting.
`plan` validates and reports the same offline sweep as JSON; `replay` aliases
`analyze`. Omit `--json` for token/cost and scoring-deviation tables plus policy
measurements. Input files must be regular files inside the current working
directory; parent traversal and symlinks escaping that directory are rejected.
Each input is bounded to 4 MiB. No paths inside captures are followed.

The combined file has exactly two fields, `cases` and `capture`. `cases` is the
array format in `test/fixtures/decision/benchmark-smoke.json`: 2–100 unique IDs
(letters, digits, hyphens, underscores), explicit tuning/holdout split, decision
input (`question`, `mode`, optional `context`), and mode-valid `expected` label.
A standalone capture may instead be supplied with `--dataset`:

```json
{
  "schema": "aiwg-decision-benchmark-capture/v1",
  "datasetDigest": "<sha256 of JSON.stringify(cases), computed by benchmarkDigest>",
  "capturedAt": "2026-10-23T00:00:00.000Z",
  "baselineLabel": "saved baseline model and settings",
  "rows": [
    {
      "id": "test-failure",
      "baseline": {
        "answer": true, "confidence": 0.9, "status": "answered",
        "model": "baseline-version", "usage": { "inputTokens": 500, "outputTokens": 20 },
        "latencyMs": 100
      },
      "jev": [
        {
          "answer": true, "confidence": 0.9, "status": "answered",
          "model": "jev-1.13.0", "usage": { "inputTokens": 500, "outputTokens": 20 },
          "latencyMs": 100
        }
      ]
    }
  ]
}
```

Include one row per case and 1–20 Jev observations per row. Answered values must
match the case mode. Fallbacks use `status: fallback` and may have a null answer;
confidence, model and usage can be null. Usage components can be null, and optional
`cachedInputTokens` must not exceed input tokens. Optional `probability` is a
0–1 truth probability used for yes/no Brier scores. The optional `cost` and
`collection` fields described above also validate within this v1 capture format.
Other unknown fields are rejected.
The JSON above illustrates a row; a valid dataset needs both splits and matching
rows for every case.

Use identical questions, contexts, rubrics and independent gold labels for both
arms. Save model versions, settings and usage when obtaining observations outside
this tool. Freeze the experiment and split before looking at results. Explicit
splits are preserved by default. `--holdout <fraction>` deterministically reassigns
cases by a SHA-256 ranking of seed and ID, independently of outcomes and file
order; retain the seed and source digest for reproduction. Do not repeatedly
reseed to improve a holdout score.

Default pass counts are available prefixes from 1, 3, 5, 10, 15, 20, plus the
minimum available pass count. Thresholds and vote agreement (comma-separated `--agreement` values) are swept on those
same prefixes. Only tuning accuracy/fallback constraints select a recommendation;
holdout measurements assess it afterward. Reports include routed and selective
accuracy, fallback rate, baseline agreement, serial latency, sample confidence and
scale-score deviation, ordinal MAE and yes/no Brier scores. One pass cannot estimate
sample SD; categorical answers receive no numeric score. Repeated passes may be
correlated, and nested prefixes are not independent experiments.

Legacy-capture pricing is optional and comes from explicit `decision.ask.cost.*`
in the existing project config, using the savings helper. New captures use their
recorded sourced costs. `llm_per_mtok` prices the
saved baseline; Jev uses a complete split pair or explicit `jev_per_mtok`. A
configured `jev_model` must match the saved model. Defaults are not treated as
benchmark evidence. Missing rates, incomplete billable usage, or nonzero cached usage
(which these blended weights cannot price exactly) produce unknown/null costs,
never an invented zero. Unknown output usage can still be priced with a complete
split pair whose output rate is explicitly zero. Explicit zero rates remain valid. No pricing refresh runs.
These are configured planning estimates, not invoices or measured subscription
savings. Routing scenarios include saved baseline expense and latency on
fallbacks; acquiring a paired capture pays both arms. A recommendation minimizes
tuning routed cost when known, otherwise serial latency, subject to quality
constraints. No policy or production configuration is changed.
