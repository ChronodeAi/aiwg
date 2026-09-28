# TV-12 bounded live collection (#2681)

This tooling collects context estimator comparisons. It does not qualify a profile,
approve a margin, enable production enforcement, or complete #2681. All tests use
fake transport and are guard/recording tests, not live qualification evidence.

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
  Freeze the margin rule's additional reserve and maximum margin before observing
  provider usage.

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
node tools/decision/context-live-qualification.mjs --collect-approved \
  /approved/approval.json /approved/corpus.json \
  /canonical/artifact/root /approved/credential-resolver.mjs \
  sha256:RESOLVER_DIGEST
```

Missing inputs, source drift (including untracked files), changed corpus or
preregistration digests, changed resolver digest, and reused run directories fail
closed. Keep approval and corpus files outside the clean source checkout. The live
runner verifies the corpus equals the complete deterministic generated corpus,
not an arbitrary subset labelled synthetic. It snapshots the approved synthetic corpus, approval and preregistration into
private mode-0600 files before dispatch. Each D11 case binds those inputs by digest.
The corpus is the approved private study input, not a provider body export; comparison
and D11 evidence contain only metadata. The existing D11 writer retains that evidence.

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
the wall-clock budget, including credential resolution. There are no retries or
fallbacks. Any provider failure (including the first limit-related 4xx), missing
request ID, changed served model, missing authoritative input/output usage, or
usage above the approved bound stops subsequent collection. A bound is a reviewed
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
rollback requirements are completed. The summary reports `collectionSuccess` separately from qualification. Missing
positive comparisons, failed/skipped D11 cases or unmatched partition counts make
collection unsuccessful; the CLI exits nonzero. Legitimate rejected-boundary cases
remain successful zero-dispatch checks. No live run has been performed by these tests.
