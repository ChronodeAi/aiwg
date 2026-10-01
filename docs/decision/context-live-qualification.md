# TV-12 bounded live collection (#2681)

This tooling collects context estimator comparisons. Collection alone does not qualify a
profile or approve a margin. Separate reviewer-gated steps, described below, record the
margin and run the enforce canary. Nothing here enables production enforcement or
completes #2681. All tests use fake transport and are guard/recording tests, not live
qualification evidence.

The entry point is `tools/decision/context-live-qualification.mjs`. This is a
source-checkout-only tool, not an installed package CLI command. With no arguments
it reports usage and makes no provider calls. `--prepare PROFILE.json CORPUS.json`
builds a reproducible synthetic corpus without resolving credentials. The output
must be beneath the canonical root returned by `aiwg artifacts path --json
--check-write`; the destination must not already exist. A current build is generated
before the runtime is imported, avoiding stale compiled code during collection.

The profile must declare the `canonical-json-utf8-ceil` estimator version `1.0.0`,
64,000 aggregate and 32,000 state-plus-longest-question limits, an explicit
`safetyMarginBps`, and `requestEnvelopeTokens`. The generator targets raw and
effective boundaries at offsets -1, 0 and +1 using actual compiled Jev questions
and D10 trust-partitioned state. It includes Unicode/nested content, 255-option
Choice, 10-level Score, many short questions, and a dominant question. It pads only
synthetic content. The estimator is not a provider tokenizer; its estimate is what
the study measures. Every dispatched request also retains its wire digest and
serialized byte count, never its body.

Prepare and freeze approval separately before collection. The
`ContextLiveApproval` interface lists required fields:

- Explicit approval, reviewer, staging workspace, unique run ID, exact clean source
  commit, and exact-head CI reference.
- Pinned served model, API revision `v1`, host-declared region, approved secret
  service logical reference, and SHA-256 digest of the trusted credential resolver.
- Request, total-token, USD and wall-clock ceilings, plus an independently approved
  per-request total-token and USD upper bound and its approval reference.
- Corpus digest and digest of `contextLivePreregistration(corpus, marginRule)`.
  The generated `context-live-preregistration/v2` also freezes the provider-failure
  policy and minimum measured case count. Old preregistration digests are refused.
  Freeze these together with the margin rule before new provider usage.

The prerequisite CI reference and human approval are supplied attestations; the
runner cannot independently authenticate the reviewer or inspect a CI service.
Approval is not inferred from file existence or from a successful offline test.
The Jev adapter currently exposes region only as a host-declared attribute, not a
transport-enforced region selection. The approver must establish staging/region
suitability before collection.

A trusted host module exports `async resolveCredential(logicalReference)` returning
credential bytes from the approved secret service. Its contents and digest require
host review. It must have no import-time side effects. The CLI accepts no transport
module or arbitrary provider endpoint. Collection invokes the real built-in Jev
adapter against its fixed v1 endpoint. The programmatic offline transport seam is always marked `synthetic`; full
orchestration tests use manifest mode `offline`. It cannot produce live evidence
or receive a live-host admission token. The CLI exposes no offline transport seam.

```sh
AIWG_DECISION_TV12_LIVE=1 node tools/decision/context-live-qualification.mjs --collect-approved \
  /approved/approval.json sha256:APPROVAL_FILE_DIGEST /approved/corpus.json \
  /canonical/artifact/root /approved/credential-resolver.mjs \
  sha256:RESOLVER_DIGEST
```

## Live-mode preflight and the #2681 spend cap

`--collect-approved` and `--canary-approved` are refused before the build, the resolver
import or any credential read when:

- `AIWG_DECISION_TV12_LIVE` is not `1`;
- `NODE_TLS_REJECT_UNAUTHORIZED` is set to anything other than `1`;
- the SHA-256 of the approval file or the resolver differs from the digest given on the
  command line.

`ARTIFACT_ROOT` must resolve to the canonical `artifact_root` itself, not a subdirectory.
Every run directory lives in the fixed ledger `research/qualification/2681/runs/` beneath it.
Every approval and canary plan is capped at USD 2.00, the #2681 limit. The cap also covers
all runs together. Before the first reservation, a run takes the ledger lock and sums the
earlier collection and canary spend:

- a run with a summary counts its charged reservation;
- a run without one (crashed or interrupted) counts its full approved budget;
- an unrecognized or unreadable entry refuses the run.

The run's USD ceiling is the smaller of its approval and USD 2.00 minus that prior spend,
and the 80% stop applies to it. When nothing remains, the run is refused. A run writes its
approval first, so an interrupted run is always charged its full budget. A stale
`.tv12-spend.lock` is never removed automatically. The approval check also requires the
collection profile's margin to reach the preregistered maximum before any spend. The host
`dispose()` zeroes the key when a run ends.

## Trusted Jev credential resolver

`tools/decision/jev-credential-resolver.mjs` is the reviewed host module for this
runner. Its logical reference is `openbao-approle.NAME.typesafe-jev`, which names
the scoped OpenBao reader AppRole. The reference goes into the Jev binding's `credentialRef`, so it must
match `^[a-z][a-z0-9.-]+$`. The approval check enforces this. On first use it runs the host token helper
(`bash $AIWG_OPENBAO_TOKEN_HELPER approle NAME`), reads the key field `token` from the
KV v2 locator in `AIWG_JEV_OPENBAO_SECRET_PATH` at the HTTPS `BAO_ADDR`, and revokes the
client token. The locator is host configuration because it is private; it is not in
source or approval artifacts. Secret-service requests set `rejectUnauthorized: true`
explicitly, and `BAO_SKIP_VERIFY` has no effect. A `NODE_TLS_REJECT_UNAUTHORIZED` value
other than `1` is refused. An internal CA needs `BAO_CACERT`, `NODE_OPTIONS=--use-system-ca`
or `NODE_EXTRA_CA_CERTS`. If the helper output fails validation, any token-shaped word in
it is still revoked. The key is held in memory for the process, each call returns a copy
that the adapter zeroes, and the exported `dispose()` zeroes the key itself.
Errors carry a fixed category, never helper, secret-service or provider text. The file
digest pinned in the approval covers the code only. The AppRole's own scope, not this
module, is what limits which secret can be read.

## Dry run

`--dry-run` takes the same arguments as `--collect-approved` and needs no live gate. It
validates the approval and corpus. It checks the pinned approval and resolver digests, the
complete generated corpus, the clean exact source commit, the canonical artifact root, and
the remaining #2681 spend. For every admissible partition it runs the same request checks as
collection: adapter destination and answer-shape capabilities, the ruleset and binding schemas
(including the credential reference), and the artifact pins. Oversized cases are recorded as
rejected, and the run moves on, exactly as in collection. It then reports the partitions collection would
send. For each case it lists the partitions and their estimated input tokens, then the
initial requests, `maximumRequestsWithRetries` (twice the initial requests), the
worst-case reserved token and USD bounds including every possible retry, and `requestCapacityAtStop`: the most
requests the 80% stop admits under the capped USD ceiling. It never imports the resolver, resolves a credential,
calls a provider or writes a file. It exits nonzero unless every precondition holds and
the plan fits before the stop.

## After collection: margin record and enforce canary

These steps are implemented and tested offline only. None has run against Jev.

1. **Margin record.** `--record-qualification APPROVAL CORPUS RUN_DIR REVIEW OUTPUT`
   reads the retained `*-comparison.json` rows and rebinds each one to its frozen
   corpus partition by plan digest, profile digest, estimate and usage digest.
   Synthetic, missing, surplus or edited rows are refused. This downstream recorder
   still requires complete partition coverage; a collection with measurement failures
   can report a candidate margin but cannot create an enforcement qualification. The selected margin is the
   preregistered rule's output: the worst undercount plus `extraReserveBps`. If that
   exceeds `maximumMarginBps`, no record is produced. The reviewer's
   `context-margin-review/v1` must approve that exact margin, the digest of these
   records, and a new profile identity. The collection profile's margin must be at
   least the preregistered maximum, so every collected request stays a single request
   under the selected margin. The output record holds the qualified profile, its digest,
   and a `ContextQualification` accepted by `assertContextQualified`.
2. **Stored-record check.** `--verify-qualification RECORD` runs the enforcement gate
   on the stored file, then confirms that the same record is rejected when only the
   profile version changes.
3. **Enforce canary.** `--canary-approved CANARY_APPROVAL APPROVAL_SHA256 CORPUS RECORD
   ARTIFACT_ROOT RESOLVER RESOLVER_SHA256` needs a `context-canary-approval/v1` that embeds the
   canary plan frozen before collection (its digest must match) and names the record
   digest, served model and region. Each planned case first runs through
   `evaluateDecisionRuleset` with native batching and `rollout: enforce` using the
   recorded qualification. It then runs again rolled back to `observe-only`, which
   evaluates every question singly. Before each phase starts, every dispatch that phase
   needs is reserved against the approved bound. The run stops at 80% of any ceiling, on
   the first failed check, or on an evaluation error. A case passes when:
   - every dispatched partition is within the effective limits;
   - every reported input is within the documented aggregate limit and the approved bound;
   - every per-call reported output is known and within the approved per-call output
     ceiling (`perRequestBound.outputTokens`, a sub-ceiling of `totalTokens`);
   - an oversized case produces a context rejection with no dispatch;
   - the rollback sends no native batch.

   Jev exposes no request-level output cap, so the output ceiling cannot be enforced
   before dispatch: it is enforced after dispatch by failing the canary on unknown
   or over-bound reported output, which stops further dispatch. A canary plan without
   the ceiling, or with a ceiling above the total bound, is rejected before any
   credential use or dispatch. Nothing here has run against Jev.

   Per-case rows and the summary are metadata only.

A canary case may have at most 8 questions, so `many-short` is rejected. An invocation
with context planning and 24 aliases currently produces a result document that exceeds the
default entry limits (`property-count`). That error is raised after dispatch, and the canary
treats it as a stop. D11 manifest linking from #2599 and #2604 remains pending.

Missing inputs, source drift (including untracked files), changed corpus or
preregistration digests, changed resolver digest, and reused run directories fail
closed. Keep approval and corpus files outside the clean source checkout. The live
runner verifies the corpus equals the complete deterministic generated corpus,
not an arbitrary subset labelled synthetic. It snapshots the approved synthetic corpus, approval and preregistration into
private mode-0600 files before dispatch. Each D11 case binds those inputs by digest.
The corpus is the approved private study input, not a provider body export; comparison
and D11 evidence contain only metadata. The existing D11 writer retains that evidence.
The generic D11 runner never invokes executors in `live` mode. Collection therefore runs every
case itself, sequentially, and then records the outcomes. It uses D11 mode `recorded` for the
provider path and `offline` for the synthetic seam. Provider provenance is in each comparison
record (request ID, served model, usage digest), not in the D11 mode label.

## Collection boundary

Ordinary `observe-only` deliberately disables native batching. This runner therefore
composes the existing D10 projection, actual question compiler, D06 planner, D02
admission controller and Jev adapter in a qualification-only path. It does not add
a rollout mode or weaken the ordinary default/enforce gates. Every planned partition
is independently replanned as exactly one complete request. Multiple questions use
`evaluateMany`; a singleton uses `evaluate`. Both receive the same projected state,
compiled questions, pinned model and policy metadata used in planning. Definition,
ruleset and binding schemas and artifact pins are validated before admission.

Oversized state or questions never reach credentials or transport. An aggregate
group that needs partitioning is not dispatched whole. Each partition has its own
wire identity, estimate, authoritative shared input usage and comparison. Shared
usage is counted once, never copied into an accounting sum per answer. The admission
lease is released once per request; conservative token and USD reservations are
never refunded. This intentionally overcounts uncertain or failed requests.

Before each dispatch the runner reserves one request and the approved token/USD
upper bound. It will not cross 80% of any ceiling. An abort signal enforces 80% of
the wall-clock budget, including credential resolution. There are no fallbacks.
The v2 preregistration allows at most one retry per request for a terminal
non-success `invalid-output`, `service-error` or `overloaded`
observation with HTTP 200 or 5xx (including 529). This covers r3's HTTP 200 with
null model and usage. Every attempt reserves and charges the full approved bound
before dispatch. Each failed attempt is persisted with case/partition, attempt,
reason, HTTP status and safe request ID; unavailable metadata stays null. A second
failure marks the case as a **measurement failure**, fails its D11 check, and
continues to subsequent partitions and cases. A successful retry retains its first
failure evidence. This policy was amended after r3, before collecting r4 scores.

Uncertain execution, timeouts, cancellation, authentication/credential anomalies,
other provider failures (including the first limit-related 4xx and rate limiting),
changed served model, missing request ID/model/authoritative input-output usage on
success, source drift, and usage above the approved bound still stop subsequent
collection. Safety and usage checks precede the retry decision. Source is checked
before each case and credential resolution; final source drift leaves a stopped
summary and preserves completed comparisons. A bound is a reviewed
assumption, not a provider-enforced output-token cap: an unexpected provider overrun
can only be detected after that request and then stops the run.

Provider cost remains `null` when absent. The approved USD bound is retained as a
reservation, not invented observed cost. Earlier partition evidence is persisted
before dispatching the next partition. Errors retain generic stop reasons rather
than provider, secret-service or request bodies. Evidence records include request
IDs after the adapter's bounded safe-ID validation, served model, estimator, plan
and profile digests, usage digest, estimated/actual input tokens, absolute token
error and undercount basis points. D11 evidence remains **HOLD** until the separate
reviewer-approved profile/margin, qualification validation, enforce canary and
rollback requirements are completed. The summary reports `collectionSuccess`
separately from qualification. The v2 summary lists `measured`, `failed`,
`rejected` and `unmeasured` case IDs
separately from `collected` request comparisons. A case is measured only when all
its partitions succeeded. Every partition of a failed or incomplete case is
excluded from margin derivation, though completed comparison files remain retained.
A candidate margin requires no immediate stop and at least **12 measured cases**
(out of 13 admissible in the frozen 17-case corpus). Fewer cases yield a null
candidate, never a zero undercount assumption. This permits one missing case for
an exploratory candidate only; it makes no coverage claim for that input class.
The rule remains worst measured undercount plus the frozen additional reserve;
`marginValid` also requires the candidate to be at most the approved maximum.
Nothing automatically promotes. Failed/skipped D11 cases or unmatched partition
counts keep `collectionSuccess` false and the CLI exit nonzero, even when collection
continues and produces a candidate margin. Legitimate rejected-boundary cases
remain successful zero-dispatch checks. No live run has been performed by these tests.

## r4 preparation and remaining evidence

The r3 collection stopped on `choice-255` after reserving USD 0.1008. The adapter's
255-option limit admits that case; see the [local capability evidence](jev-transport.md).
The corpus and estimator are unchanged. The preregistration changes, so r4 needs
an approval pinned to the new clean HEAD and preregistration digest. When running
from a worktree, set `AIWG_ARTIFACTS_PATH` to the existing canonical artifact store
used by r3 before the artifact-root check and dry-run. Using an empty worktree-local
ledger would omit prior spend. The dry-run automatically reads the existing ledger;
never insert a manual zero or copy only selected runs.

Offline tests establish the failure policy, reservation, continuation and margin
checks. Fresh r4 Jev responses, exact-HEAD CI sign-off, operator approval, a human
margin review, complete coverage for the downstream recorder, enforce-canary and
rollback evidence remain pending. The prepared approval is an operator sign-off
candidate; the offline dry-run does not authenticate human approval or CI status.
