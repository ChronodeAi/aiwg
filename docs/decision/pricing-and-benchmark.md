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
