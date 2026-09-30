# D12 live paired qualification (#2686)

This tooling collects live paired evidence for the experimental dependent decision
graph runtime (#2608). It compares each graph pattern with a flat single-call
FlowGraph baseline on a preregistered synthetic workload. It does not promote the
graph runtime out of experimental status. A named reviewer makes that decision.
All repository tests use an injected fake transport. They are guard and recording
tests, not live evidence, and no live Jev call has been made for this issue yet.

## Arms

For every task, both arms run through the existing Flow executor and ask Jev
through `evaluateDecisionRuleset` with the D10 projection. Jev sees only the
synthetic `subject` and the node's declared predecessor `evidence`.

| Pattern | Flat baseline (one call) | Candidate graph (compiled template) | Worst-case calls |
|---|---|---|---|
| `shortlist-rerank` | Choose one of 8 catalog items or `none` | A shortlist picks a section or `none`. On `none` the graph ends as `empty-shortlist`, otherwise a rerank picks a position among that section's 4 items | 1 vs 2 |
| `taxonomy-beam` | Choose one of 10 support categories | A fixed host-local taxonomy stage feeds 2 branch scores (0-4). The host beam selector keeps the top branch (width 1, ties go to the lower ID) and a detail node picks one of its 5 leaves | 1 vs 3 |
| `extractor-verifier-fallback` | Read the current parcel status (6 options) | An extractor, then a verifier (`supported`/`not-supported`), then an ordinary fallback only when it is not supported | 1 vs 3 |

The model's answer only selects among options the host declared. Host projectors
map a shortlist section or rerank position back to a catalog ID from the frozen
task, never from model text. The taxonomy stage and the beam selector make no
inference and have zero usage. Arm order alternates by task index.

## Preregistered workload and analysis

`docs/decision/evidence/dag-live-v1/` holds the frozen inputs. Both files are
registered in the decision fixture registry, and `graph-live-qualification.test.ts`
regenerates them byte for byte:

- `workload.json`, `dag-live-workload/v1`, digest
  `sha256:fb99a6f8aa806aed16f6ef9e5d3aab8025532fa0c6de5997cd0226cca21b5c8b`. It holds
  300 labelled synthetic tasks, 100 per pattern, from seed `0x2686` with the
  repository LCG. The data is a fictional office-supply catalog, support tickets
  and parcel logs, with no customer or personal data. Slices cover no-match near
  misses, tickets with off-topic asides, and superseded or distractor parcel notes.
- `preregistration.json`, `dag-live-preregistration/v1`, digest
  `sha256:e3ba1ed045c01326d8429c13192dfcce7954c94b4819b79a41fd71e4481f5b60`. It
  binds the workload digest and the digest of every per-task definition pin. It
  also fixes the following:
  - Quality: exact-match accuracy, paired by task, with the Newcombe method 10
    interval at a two-sided `levelBps` of 9000. The non-inferiority margin is
    **-1000 bps**: the candidate may be at most 10 points worse, tested one-sided
    at 5%.
  - Economics bounds: a call ratio of at most 3, a p95 latency ratio of at most 4,
    and at most 8000 extra tokens per task. The extra-token bound applies to the
    upper limit of a seeded paired bootstrap at 90% (seed `0x2686`, 20,000
    resamples).
  - Stop rules, a per-call token bound of 4000 and concurrency 1.

The helpers are the shared `pairedBinaryDifferenceInterval`, `pairedNonInferiority`,
`wilsonScoreInterval` and `pairedMeanDifferenceBootstrap`. A pattern is `eligible`
only when all of the following hold:

- All 100 pairs completed.
- The difference's lower bound is at or above the margin.
- Every economics bound holds. A null ratio fails.

Changing the margin or any threshold changes the preregistration digest. The
runner then rejects it.

## Budget and stop conditions

The USD caps rest on an operator-attested price bound, not on a hard-coded price.
`approval.json` must carry `priceBound`, and an approval without it is rejected:

- `inputUsdPerMTok` and `outputUsdPerMTok`: attested per-token prices.
- `perRequestUsd` (optional): an attested minimum price per request.
- `evidenceReferences`: 1 to 8 references the operator relies on, such as public
  pricing pages or a live usage receipt.
- `approvalReference`: where the operator attested the bound. Placeholder values
  starting with `<` are rejected.

Before every call, the reservation is taken from the whole-run and per-pattern
ceilings, before credential resolution and transport. It covers the 4000-token worst
case at the larger of the attested price and a USD 0.10 per 1M floor, and it is never
below `perRequestUsd`. Settlement replaces the reservation with the reported usage at
the same rates, including usage above the reservation. A call with missing usage
keeps at least its whole reservation, and calls are never refunded.

An approval cannot raise the USD cap above the **USD 2.00** hard cap, and that cap
spans reruns. Before a run, the runner scans earlier D12 runs under the artifact
root:

- A run with a summary counts its charged USD.
- A run with an approval but no summary (crashed or killed) counts each logged call
  plus one in-flight call at its reservation.

The approval's `priorSpendUsd` is only a floor. The run cap is the lower of the
approval's USD budget and USD 2.00 minus the prior spend. The runner refuses to start
if that cap cannot cover one reservation before the stop.

The run stops, with no retry, on any of these:

- Any calls, tokens, USD or wall-clock dimension reaches 80%.
- A pattern's cumulative candidate calls exceed 3x its baseline calls.
- A Flow node could request an action, capability or permission (speculative action).
- A provider error or timeout, a missing request ID, unknown usage, usage above the
  reservation, or a served model that differs from the approved model.

Pairs completed before a stop stay in `pairs.jsonl`. A stopped run is never eligible.
The request that stopped the run is recorded in `calls.jsonl`, and in the summary as
`stoppingCall`, with its reported usage. It is charged to spend.

Jev reports no price. Reported billable cost uses the attested prices: USD 0.042 per
1M input tokens, with output free. Charges use the rates above.

## Usage (source checkout only)

```bash
node tools/decision/dag-live-qualification.mjs                  # dry run: plan + approval template, no credentials
node tools/decision/dag-live-qualification.mjs --dry-run APPROVAL.json [ARTIFACT_ROOT]  # with prior spend
node tools/decision/dag-live-qualification.mjs --freeze OUT_DIR  # regenerate the frozen inputs
AIWG_DECISION_DAG_LIVE=1 node tools/decision/dag-live-qualification.mjs --collect-approved \
  APPROVAL.json "$(aiwg artifacts path --json --check-write | jq -r .artifact_root)" \
  tools/decision/jev-openbao-credential.mjs sha256:<resolver digest>
node tools/decision/dag-live-qualification.mjs --record-decision RUN_DIR promote|hold roctinam "rationale"
```

The dry run, `--freeze` and `--record-decision` never build. They run the TypeScript
source through the `tsx` dev dependency, so they are safe on the titan host, which
does not allow heavy builds. Only `--collect-approved` runs `npm run build:cli`.

The dry run reports worst-case calls, tokens and reserved USD for the frozen
workload against the default or approved limits. On the defaults, the worst case is
1100 calls, 4.4M reserved tokens and USD 0.44 reserved, well inside the USD 2.00 cap.
The visible-payload estimate is about 0.32M tokens. Jev's own prompt overhead is not
included. The assessment estimated about 1.7M billed tokens, roughly USD 0.07 at the
input price.

`--collect-approved` requires `AIWG_DECISION_DAG_LIVE=1`. It rebuilds from source,
requires a clean checkout at the approved commit, and checks the approval against
both digests. It also requires the resolver file to match its pinned SHA-256 and the
artifact root to be the canonical AIWG root. Run it sequentially on the titan
staging host.

`tools/decision/jev-openbao-credential.mjs` maps the logical reference
`openbao.typesafe.jev.api-key` to the vaulted secret's `token` field. It gets a vault
token by logging in as the scoped `aiwg-jev-reader` AppRole through the itops OpenBao
helper, then reads the secret over Node HTTPS with certificate verification always on
(`rejectUnauthorized: true`, with an optional `BAO_CACERT`). It refuses to run when
`NODE_TLS_REJECT_UNAUTHORIZED=0`. After the read it revokes its own vault token, even
when the read failed.

Errors carry a fixed category only, so no key, path, token or helper text reaches an
error, log or artifact. The runner reads the key once per run and zeroes its copy at
the end.

This resolver mirrors the TV-12 resolver proposed in #2770, which is not on main and
uses a logical reference that does not fit this runner's binding `credentialRef`.
The duplication stays until one shared resolver lands.

## Evidence

Everything is written create-once under `<artifact root>/<runId>/`:

- `approval.json`, `workload.json` and `preregistration.json` are written before any
  credential use.
- `calls.jsonl` holds metadata only: node, request ID, served model, tokens and latency.
- `pairs.jsonl` holds the per-task answers, correctness, calls, tokens and latency.
  The candidate record also carries the graph receipt digest and the calls and tokens
  spent on unused speculative branches.
- `summary.json` holds the per-pattern analysis, the file digests and the stop reason.
- `g5-load-result.json` is a `decision-load-result/v1` record of observed resources
  against the approved bounds. Only an unstopped live run attaches it as the G5 gate
  artifact.
- `run-manifest.json` and `evidence-manifest.json` come from D11. Each pattern case
  re-reads the digest-bound `pairs.jsonl` and recomputes its analysis. It passes only
  for an unstopped, eligible, live run.
- `g6-review-request.json` holds the outcome digest that the reviewer signs.

`--record-decision` writes `g6-review-record.json` (`decision-qualification-review/v1`)
and `promotion-decision.json`. Only the approved promotion owner can record a
decision. `promote` is refused unless the summary still matches its review request
and the run was live, unstopped and eligible for every pattern. `hold` is always
available.

## Operator approval

The promotion owner approves the preregistration by replying with one line:

> I, roctinam, approve D12 live qualification (#2686): workload sha256:fb99a6f8aa806aed16f6ef9e5d3aab8025532fa0c6de5997cd0226cca21b5c8b, preregistration sha256:e3ba1ed045c01326d8429c13192dfcce7954c94b4819b79a41fd71e4481f5b60, non-inferiority margin -1000 bps at 90% two-sided Newcombe-10; I attest a Jev price bound of USD 0.042/1M input and USD 0/1M output (evidence: https://www.eesel.ai/blog/typesafe-jev-pricing, https://www.mindstudio.ai/blog/jev-pricing-cost-per-token, live smoke roctinam/aiwg#2613 comment 153093, jev-1.13.0, 369 input / 38 output tokens), reserved at no less than USD 0.10/1M; USD 2.00 cap across all runs, sequential on titan.

## Open items

These need live inputs and are not met by this change:

- The operator approval above, and a filled `approval.json`. It needs the pinned
  model, region, exact-head CI and commit, `priceBound.approvalReference` pointing at
  that approval, `priorSpendUsd`, and the resolver digest.
- A live run on titan.
- The reviewer's promote-or-hold record.
- Linking the evidence manifest from #2608.
