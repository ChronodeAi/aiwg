# Shared held-out study collector

The experimental collector is default-off. It collects synthetic observations
for source-controlled D17 and D29 study modules; it never promotes a model,
changes a workflow, approves an SDLC gate or claims a study has passed. The
checked-in example is a two-subject plumbing demonstration, not held-out data.
No live collection was performed for this implementation (#2611, #2622).

## Source-only commands

These commands use the existing `tsx` development dependency, without a build:

```bash
node tools/decision/heldout-study.mjs
node --import tsx --input-type=module -e \
  "import {prepare} from './agentic/code/addons/decision-engine/examples/heldout-collector-offline.mjs'; console.log(JSON.stringify(await prepare('demo')))"
```

The first command prints usage. The second generates only fictional example
inputs and separate local gold. To freeze a reviewed study module, first resolve
`aiwg artifacts path --json --check-write`, then use a new directory immediately
below that canonical artifact root:

```bash
node tools/decision/heldout-study.mjs --prepare STUDY.mjs SEED OUTPUT_DIR
node tools/decision/heldout-study.mjs --dry-run BUNDLE.json APPROVAL_DIGEST ARTIFACT_ROOT
```

Prepare stores corpus, preregistration and gold separately with exclusive file
creation. Its incomplete approval template is deliberately invalid for
collection. Assemble `BUNDLE.json` from the corpus, preregistration and an actual
operator approval. `APPROVAL_DIGEST` is `heldoutDigest(bundle.approval)`, a
canonical JSON digest, not a hash of file formatting. Keep this trusted digest
in the external approval record. The bundle and all study analysis/gold files
belong in the protected artifact store, outside the clean source checkout.

`--collect-approved` has the same arguments as `--dry-run` and additionally
requires `AIWG_DECISION_HELDOUT_LIVE=1`. It is an operator execution surface;
this documentation is not approval to use it. Library collection additionally
requires `enabled: true`. Without that flag, the library returns `disabled`
before reading inputs or invoking any hook. Injected transports are labelled
`injected-transport` throughout evidence and never presented as live origin.

## Approval and accounting

The closed v1 corpus, preregistration, approval, frozen-input, attempt, event and summary
schemas are under `schemas/decision/Heldout*.v1.schema.json`. Definitions and
receipts also pass the existing decision validators. Unknown fields, null price
rates/fees, null calibration pins, changed approval pins, duplicate payloads,
cross-split families and non-synthetic provenance fail before dispatch.

Approval binds the corpus and preregistration, requested/served `jev-1.13.0`,
all execution definition/ruleset/binding/projection pins, adapter version,
calibration digest, resolver file digest, clean exact source commit, CI evidence
reference, reviewer, titan workspace, provider terms reference and run ceilings.
CI and provider terms references are operator attestations, not remotely
verified results. A calibration digest pins an artifact; it does not establish
D09 compatibility. Study scorers must use the existing calibration registry.

Every attempt, including retries and failures, fsyncs its full token/USD
reservation before credential resolution or dispatch. Tokens are priced at the
maximum of the attested input rate, output rate and USD 0.10 per million, plus
the attested request fee. A token-only tariff explicitly attests a zero fee;
null is invalid. Successful small usage never refunds a reservation. Unknown
usage retains its full reservation; observed overruns increase accounted spend
and stop collection. Provider cost stays null when absent. Reserved dollars
are conservative bounds, never provider-reported charges or net savings.

D17 has a hard USD 8 study cap; D29 has USD 6. The portfolio ceiling is USD 48.
The collector scans every prior run beneath the exact canonical artifact root
and takes the larger of scanned spend and each operator-attested prior-spend
floor. The portfolio floor must include spending outside this collector.
Admission stops before a dispatch exceeds 80% of the effective remaining USD,
call or token ceiling. Dry-run reports worst-case completion feasibility;
collection also guards each reservation, including partial sessions.

A filesystem lock serializes arms, processes and studies using this collector.
It does not serialize unrelated legacy runners. Dispatches are at least one
second apart. Sessions are at most 30 minutes, with the same 80% stop rule.
Before starting a subject, the collector checks whether every remaining arm
and allowed retry can fit its worst-case time. A new approved run ID resumes
completed requests without recollecting them; its evidence pins prior run
journals. Frozen corpus/preregistration changes cannot reuse prior observations.

The preregistered failure policy allows zero or one retry. Only terminal
invalid-output, overloaded or 5xx service-error responses qualify. Such errors
may have unknown usage/identity; they remain failed observations charged at the
full bound, never compatible successful results. Exhausting retries creates a
measurement failure. Once failures exceed the registered tolerance (at most
5%) within a split/slice, that slice receives no further calls. Missing rows
remain explicit. A completed traversal can therefore still have missing data.

Unknown execution, timeouts, cancellation, auth/privacy failures, served-model
change, successful responses missing identity/usage, and usage/price overruns
stop the run. Completed receipts remain durable. Unknown execution retains the
global lock; restart refuses unresolved reservations or prior stopped attempts.
Operator reconciliation is required. There is deliberately no automatic
stale-lock removal or retry of uncertain remote execution.

## Projection, credentials and evidence

The runtime reuses D10 projection and the existing Jev adapter/evaluator. Only
`input.payload` reaches model-visible state, explicitly marked untrusted/public;
gold, local outcomes, IDs, slices and other control fields stay local. Known
credential syntax is rejected before collection, and resolved credential bytes
are scanned against captured output, observations, receipts and traces. The
collector suppresses stream/console output during each attempt, discards raw
exception text, uses existing redaction, and disposes the resolver after the run.
Trusted study modules must not launch child workers; this collector has no
child-worker execution API. The existing resolver's helper output stays piped
inside the resolver and its errors are fixed categories.

Live resolution uses only `tools/decision/jev-credential-resolver.mjs`, pinned
by its byte digest. It enforces verified TLS and a scoped AppRole logical
reference, calls revoke-self after the read, and keeps key bytes in memory.
The reused resolver attempts revocation on all token-bearing paths; its
revocation request is best-effort, as documented in that module. No new resolver
or alternative credential lookup is introduced here.

Each hash-chained journal records reservations, terminal dispositions, request
and bounded-response byte digests, served identity, nullable usage, receipt
pins and trace pins. The adapter observer scans bounded response bytes before answer validation,
so an invalid answer cannot hide model drift, usage overrun or credential
material. Raw provider bodies are never retained. Only safe receipts/traces are stored. Reread
verification rejects changed frozen files, broken chains, truncated completed
journals, missing traces, mismatched receipt hashes and altered reservations.
The external trusted evidence digest binds both the journal and frozen inputs,
including prior-run references. File hashes detect changes against that pin;
they are not signatures or a substitute for protected storage.

D11 execution uses `recorded` mode, re-reading the journal before recording a
pass/fail evidence artifact and source-linked evidence manifest. This proves
ledger replay integrity, not live origin, model quality, privacy approval or
release readiness. No G3/G5/G6 flags are fabricated.

## Study modules and remaining inputs

`HeldoutStudyModule.prepare(seed)` returns a corpus, preregistration and separate
gold. CLI preparation checks the module's generator/scorer byte digests and
gold digest. `scoreHeldoutStudy` rechecks trusted approval/evidence/gold/scorer
pins and validates digest-bound upstream eval-integrity before calling the
local scorer. The library wrapper always returns HOLD or preserves ROLLBACK,
including when diagnostics contain a proposed PROMOTE. A scorer callback is
trusted host code, not a model-supplied executable. Its actual module digest
must be independently checked by the caller, as CLI preparation does.

A row can have multiple named arm requests (D17 single champion plus independent
ensemble members), or zero requests with an observed local outcome (D29 failed
hard prerequisites). Model output cannot select IDs, ranks or protected status.
Study modules must implement their own native observation mappings and gold
oracle; the collector does not fabricate distributions, calibration or reviews.

The following remain open, with no live acceptance claim:

| Study work | Exact missing input |
| --- | --- |
| D17 measured ensemble report, AC7/AC14 | Fresh frozen 1,800-subject generator/oracle, D09 calibration, Jev observations, native eight-metric mapping, preregistered Newcombe/bootstrap/coverage gates, approved extra-cost tradeoff and blind review |
| D29 measured screening report, AC8/AC9/AC13 | Fresh 1,600-subject corpus/oracle, projected question mapping, calibrated readiness, real observations, native false-rate/NI and external coverage gates, blind gold/reviewer audit and integrity snapshot |
| Any live collection | Priced approval with real evidence references, clean source/CI attestation, canonical root, actual prior spend, resolver pin, synthetic privacy approval and provider terms record |
| Promotion or production rollout | All native and external thresholds evaluated against complete data, compatible calibration, protected eval-integrity evidence and separate operator approval |

The collector preregistration pins a **separate study analysis digest**. It does
not implement D17/D29 quality thresholds or economics. Their existing report
builders and additional study-specific gates remain the scorer's responsibility.
No PROMOTE can be obtained from this collector. Incomplete native endpoints
must stay missing, with a complete-case appendix and failure-as-error analysis
prepared by the eventual study module; the example supplies neither analysis.
