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

### Trusted Jev credential resolver

`tools/decision/jev-credential-resolver.mjs` is the reviewed host module for this
runner. Its logical reference is `openbao-approle:NAME/typesafe/jev`, which names
the scoped OpenBao reader AppRole. On first use it runs the host token helper
(`bash $AIWG_OPENBAO_TOKEN_HELPER approle NAME`), reads the key field `token` from the
KV v2 locator in `AIWG_JEV_OPENBAO_SECRET_PATH` at the HTTPS `BAO_ADDR`, and revokes the
client token. The locator is host configuration because it is private; it is not in
source or approval artifacts. TLS is always verified and `BAO_SKIP_VERIFY` is ignored, so
an internal CA needs `NODE_OPTIONS=--use-system-ca` or `NODE_EXTRA_CA_CERTS`. The key is
held in memory for the process and each call returns a copy that the adapter zeroes.
Errors carry a fixed category, never helper, secret-service or provider text. The file
digest pinned in the approval covers the code only. The AppRole's own scope, not this
module, is what limits which secret can be read.

### Dry run

`--dry-run` takes the same arguments as `--collect-approved`. It validates the approval
and corpus, checks the complete generated corpus, the clean exact source commit, the
canonical artifact root and the resolver pin, and reports the partitions collection would
send. For each case it lists the partitions and their estimated input tokens, then the
total requests, the reserved token and USD bounds, and `requestCapacityAtStop`: the most
requests the 80% stop admits. It never imports the resolver, resolves a credential,
calls a provider or writes a file. It exits nonzero unless every precondition holds and
the plan fits before the stop.

## After collection: margin record and enforce canary

These steps are implemented and tested offline only. None has run against Jev.

1. **Margin record.** `--record-qualification APPROVAL CORPUS RUN_DIR REVIEW OUTPUT`
   reads the retained `*-comparison.json` rows and rebinds each one to its frozen
   corpus partition by plan digest, profile digest, estimate and usage digest.
   Synthetic, missing, surplus or edited rows are refused. The selected margin is the
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
3. **Enforce canary.** `--canary-approved CANARY_APPROVAL CORPUS RECORD ARTIFACT_ROOT
   RESOLVER RESOLVER_SHA256` needs a `context-canary-approval/v1` that embeds the
   canary plan frozen before collection (its digest must match) and names the record
   digest, served model and region. Each planned case first runs through
   `evaluateDecisionRuleset` with native batching and `rollout: enforce` using the
   recorded qualification. It then runs again rolled back to `observe-only`, which
   evaluates every question singly. Before each phase starts, every dispatch that phase
   needs is reserved against the approved bound. The run stops at 80% of any ceiling, on
   the first failed check, or on an evaluation error. A case passes when:
   - every dispatched partition is within the effective limits;
   - every reported input is within the documented aggregate limit and the approved bound;
   - an oversized case produces a context rejection with no dispatch;
   - the rollback sends no native batch.

   Per-case rows and the summary are metadata only.

The canary uses cases with few questions. An invocation with context planning and 24
aliases currently produces a result document that exceeds the default entry limits
(`property-count`). That error is raised after dispatch, so the canary treats it as a
stop. D11 manifest linking from #2599 and #2604 remains pending.

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
