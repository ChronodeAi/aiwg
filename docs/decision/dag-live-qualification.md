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
  `sha256:e42dfdf852c142f84d24cdb0210f5161653ea781205685f2ff46b55035549683`. It
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
  - Stop rules, the provider-failure policy, a per-call token bound of 4000 and
    concurrency 1.

The helpers are the shared `pairedBinaryDifferenceInterval`, `pairedNonInferiority`,
`wilsonScoreInterval` and `pairedMeanDifferenceBootstrap`. A pattern is `eligible`
only when all of the following hold:

- All 100 tasks were attempted.
- At most 5 of them (5%) are measurement failures. Those are excluded from both arms
  and from the paired table.
- The difference's lower bound is at or above the margin.
- Every economics bound holds. A null ratio fails. Call ratios count first attempts
  only; retries are charged and reported separately.

Each pattern gets a verdict: `eligible`, `not-eligible`, or `insufficient-evidence`
when measurement failures exceed the tolerance.

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
spans reruns. The artifact root must be the canonical AIWG artifact root itself,
compared by real path, and not a subdirectory of it. Before a run, the runner scans
recursively for every earlier D12 run below that root:

- A run with a summary counts its charged USD.
- A run with an approval but no summary (crashed or killed) counts each logged call
  at its charged amount, or at the reservation if a line carries none. It also counts
  one in-flight call at the reservation.

The approval's `priorSpendUsd` is only a floor. The run cap is the lower of the
approval's USD budget and USD 2.00 minus the prior spend. The runner refuses to start
if that cap cannot cover one reservation before the stop.

Jev returns occasional non-success outcomes. The #2613 study measured about 2-3%
invalid output on nominal inputs, so a zero-tolerance run would almost never finish
1,100 calls. The preregistered provider-failure policy is:

- **Retryable outcomes:** invalid output (including HTTP 200 with null usage), a
  timeout (including the per-task deadline), a network error, a rate limit, overload,
  a 5xx, or a successful answer with missing usage.
- **One retry:** each retryable outcome gets at most one retry. The retry is reserved
  before dispatch and charged like any call; a not-sent attempt keeps its full
  reservation.
- **Measurement failure:** if the retry also fails, the task is a measurement failure
  in both arms. It is recorded in `pairs.jsonl` with `measurementFailure` and
  excluded from the Newcombe table. Any remaining arm is not run.
- **Tolerance:** more than 5% of a pattern's tasks failing makes that pattern
  `insufficient-evidence`. The runner stops spending on it and moves to the next
  pattern. The run itself does not stop.

The run stops at once, with no retry, on any of these:

- Any calls, tokens, USD or wall-clock dimension reaches 80%.
- A pattern's cumulative first-attempt candidate calls exceed 3x its baseline calls.
- A Flow node could request an action, capability or permission (speculative action).
- A served model that differs from the approved model, usage above the reservation,
  or a missing request ID.
- A credential, authorization or data-boundary failure, an invalid request, an
  adapter exception, or any other provider outcome outside the retryable list.

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
workload against the default or approved limits. The worst case assumes the
preregistered retry on every call: 1100 first attempts plus 1100 retries, so 2200
calls, 8.8M reserved tokens and USD 0.88 reserved, well inside the USD 2.00 cap.

The default ceilings leave room for that under the 80% stop:

- Whole run: 3000 calls, 12M tokens and USD 2.00.
- Per pattern: 1000 calls, 4M tokens and USD 0.50.

The earlier ceilings of 1400 and 500 calls had no room for retries: taxonomy alone
used the whole per-pattern call stop.
The visible-payload estimate is about 0.32M tokens. Jev's own prompt overhead is not
included. The assessment estimated about 1.7M billed tokens, roughly USD 0.07 at the
input price.

`--collect-approved` requires `AIWG_DECISION_DAG_LIVE=1`. It rebuilds from source,
requires a clean checkout at the approved commit, and checks the approval against
both digests. It also requires the resolver file to match its pinned SHA-256 and the
artifact root to be the canonical AIWG artifact root itself. The approval's
`reviewer` must be the preregistered promotion owner. Run it sequentially on the titan
staging host.

The approval pins the secret service in `secretService`:

- `origin`: the exact HTTPS vault origin.
- `secretPathDigest`: the SHA-256 of the KV secret path's UTF-8 bytes.

The default template pins `https://rca-g2.s9.internal:8200` and
`sha256:5764c8bf2bf4a92eea32619f3d9a25fd2a1b5e675646f7ff30d425b1f791a883`. The runner reads the resolver file once, checks those bytes against both
digest pins, imports the same bytes, and builds the resolver with the approval's
secret-service pin.

The resolver refuses the following before it requests a vault token:

- a `BAO_ADDR` or `AIWG_JEV_OPENBAO_SECRET_PATH` that differs from the pin;
- a missing pin.

`tools/decision/jev-openbao-credential.mjs` maps the logical reference
`openbao.typesafe.jev.api-key` to the vaulted secret's `token` field. It gets a vault
token by logging in as the scoped `aiwg-jev-reader` AppRole through the itops OpenBao
helper, then reads the secret over Node HTTPS with certificate verification always on
(`rejectUnauthorized: true`, with an optional `BAO_CACERT`). It refuses to run when
`NODE_TLS_REJECT_UNAUTHORIZED=0`. After the read it revokes its own vault token. It
also revokes a helper token that fails validation, if the token can be sent as a
header at all, and it revokes when the read failed.

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
decision. That reviewer must also be the `promotionOwner` in the run's
digest-bound `preregistration.json`. `promote` is refused unless the summary still matches its review request
and the run was live, unstopped and eligible for every pattern. `hold` is always
available.

## Operator approval

The promotion owner approves the preregistration by replying with one line:

> I, roctinam, approve D12 live qualification (#2686): workload sha256:fb99a6f8aa806aed16f6ef9e5d3aab8025532fa0c6de5997cd0226cca21b5c8b, preregistration sha256:e42dfdf852c142f84d24cdb0210f5161653ea781205685f2ff46b55035549683, non-inferiority margin -1000 bps at 90% two-sided Newcombe-10; I attest a Jev price bound of USD 0.042/1M input and USD 0/1M output (evidence: https://www.eesel.ai/blog/typesafe-jev-pricing, https://www.mindstudio.ai/blog/jev-pricing-cost-per-token, live smoke roctinam/aiwg#2613 comment 153093, jev-1.13.0, 369 input / 38 output tokens), reserved at no less than USD 0.10/1M; vault pinned to https://rca-g2.s9.internal:8200 and secret path sha256:5764c8bf2bf4a92eea32619f3d9a25fd2a1b5e675646f7ff30d425b1f791a883; USD 2.00 cap across all runs, sequential on titan.

## Open items

These need live inputs and are not met by this change:

- The operator approval above, and a filled `approval.json`. It needs the pinned
  model, region, exact-head CI and commit, `priceBound.approvalReference` pointing at
  that approval, `priorSpendUsd`, the `secretService` pin, and the resolver digest.
- A live run on titan.
- The reviewer's promote-or-hold record.
- Linking the evidence manifest from #2608.
