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
An offline seam must contain a callable transport and host credential/disposal
methods. Incomplete seams fail before preflight, artifact writes or credential
lookup. The collector always supplies an explicit adapter transport; only the
fully gated live path can call production fetch, after approval and resolver
pin checks. The live environment and TLS gates are checked again at dispatch.

## Approval and accounting

The closed v1 corpus, preregistration, approval, baseline, spend-event, spend-head,
frozen-input, attempt, event and summary schemas are under
`schemas/decision/Heldout*.v1.schema.json`. Definitions and receipts also pass the existing decision validators. Unknown fields, null price
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
reservation before credential resolution or dispatch. The collector computes
the UTF-8 byte length of the D10-projected, serialized request and adds the
preregistered `providerOverheadTokens` allowance (default 512). This is the
input-token reservation. `perRequestTokenBound` must cover it plus
`outputAndHiddenTokenAllowance`; otherwise collection refuses the payload.
The transport checks the actual body's byte length and digest against the
planned request before sending it. Each input reservation costs:

```text
ceil((serialized UTF-8 bytes + providerOverheadTokens)
     * max(attested input USD/MTok, 0.10))
+ ceil(attested per-request USD * 1,000,000)  // total in microdollars
```

The Jev adapter requires an attested output price of **exactly zero**. Any
positive or unknown output price is refused, even with `outputTokenBound`,
because the wire request has only `state`, `model` and `questions`: Jev has no
remote generation limit. `outputTokenBound` is only a post-response halt signal;
it cannot authorize paid output or increase a reservation. Token reservations
include the preregistered output allowance. Null rates, fees, overhead and
explicit null output bounds are invalid. Successful small usage never refunds
a reservation. Unknown usage retains its reservation; observed overruns increase
accounted spend and stop collection. Provider cost stays null when absent.
Accounted dollars are conservative charges, never net savings.

D17 admission has a USD 8 study ceiling; D29 has USD 6. The portfolio ceiling
is USD 48. Before each dispatch, accounted run spend plus the next worst-case
reservation must fit 80% of the minimum of the approved budget, remaining study
cap and remaining portfolio cap. The collector rejects an approval whose budget
cannot cover even one of its planned calls (including a USD 0.0005 approval
with a larger reservation). Calls and reserved tokens also stop at 80% of approval.

The collector records each operator floor once, with its approval digest and
the counter's genesis digest, in
`research/qualification/heldout/baselines/{D17,D29,portfolio}.json` beneath the
canonical artifact root. The initial floors must include spending outside this
collector; subsequent approvals repeat the original floors.

A separate `research/qualification/heldout/spend-counter.jsonl` records every
reservation and settlement across both studies. Each append is hash-chained and
fsynced; settlement only adds observed excess and never subtracts a reservation.
The counter stores cumulative collector charges and derives totals per study.
For each scope, accounted spend is the maximum of its baseline, its baseline
plus counter charges, and its baseline plus scanned run charges. Deleting a run
directory, or its events and summary together, therefore cannot restore allowance.
The counter also preserves unresolved/stopped-attempt status after such deletion.
Lost run receipts cannot be reconstructed from this compact counter.

`spend-head.json` independently anchors the latest sequence/digest. It is
replaced atomically and its directory fsynced after every counter append.
A surviving baseline with a missing, truncated or broken counter, a mismatched
head, or an interrupted head update refuses further collection with
`spend-counter-operator-repair-required`. This includes truncation to a valid
chain prefix after deleting all run directories. Preserve the counter, head,
baselines and remaining run evidence; an operator must reconcile them against
protected backups and provider billing. Never delete these files to restart.
There is no automatic repair, migration or baseline reset. Old baselines without
a genesis pin also require reconciliation. Dry-run uses the same accounting
without creating baseline/counter records.

Under the attested free-output tariff, the only residual per-call cost overrun
is provider-side input tokens exceeding serialized bytes plus the overhead
allowance. Any reported excess halts the run immediately and is charged to the
counter, including the stopping call. This allowance is preregistered, not a
provider-enforced limit. A tariff violation or unreported charge remains outside
that assumption and requires billing reconciliation. Free output may exceed a
halt threshold without increasing its attested charge. Concurrent spending by
unrelated runners remains outside this ledger.

The counter is append-only in collector code; filesystem permissions and
protected backups remain essential. Hashes and a local head do not prevent a
coordinated rollback of the counter, head, baselines and all run evidence. A
crash between durable writes fails closed and can require operator repair.
The current counter reader caps the file at 32 MB and rereads its chain before
each append; larger histories require reviewed archival/repair tooling, not
silent truncation. Full-study throughput is not qualified by these offline tests.

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
gold. CLI preparation checks the study module's scorer byte digest, requested
seed and gold digest. Collection independently re-derives `generatorDigest`
from the registered generator implementation bytes and requires the corpus
seed to match the common seed component of every row seed. Every row additionally
carries `provenance.generatorId`, `seed` and `outputDigest`. The collector
re-runs the source-controlled generator and compares the complete row (excluding provenance) and its digest. Rehashed
copied input, unknown generators and missing provenance fail before dispatch.
Corpus data cannot register generators or choose executable module paths.
World seed components and corpus seeds must match `[a-z0-9][a-z0-9-]{0,31}`; row seeds
append a one-to-five-digit index and one of `example`, `single`, or `local`.
Whitespace, instruction punctuation, non-ASCII text and overlong components
are rejected. The dispatched world name is `w-` followed by 16 hex digits
derived from the seed digest, so even permitted seed text stays out of model-visible
state. A bounded identifier still needs synthetic provenance review;
this constraint does not prove that an identifier has no external meaning.
Only the fictional `heldout-lamp/v1` example generator currently ships; actual
D17/D29 generators require reviewed registry additions and fresh corpus pins.
This proves reproducibility, not held-out quality or correctness of the gold.
These experimental v1 contracts are tightened in place: earlier unproven rows
must be regenerated, and approvals/attempt token reservations must be refreshed.
Generator changes require fresh corpus pins; existing ledgers are not migrated
automatically across these experimental contract changes.

`scoreHeldoutStudy` rechecks trusted approval/evidence/gold/scorer
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
| D29 measured screening report, AC8/AC9/AC13 | [Study module](d29-heldout-study.md) implements the corpus/oracle, individual question mapping, calibration recipe and report gates. Actual observations, compatible D09 artifact, operator gold/reviewer audit and protected integrity/access records remain missing. |
| Any live collection | Priced approval with real evidence references, clean source/CI attestation, canonical root, actual prior spend, resolver pin, synthetic privacy approval and provider terms record |
| Promotion or production rollout | All native and external thresholds evaluated against complete data, compatible calibration, protected eval-integrity evidence and separate operator approval |

The collector preregistration pins a **separate study analysis digest**. It does
not implement D17/D29 quality thresholds or economics. Their existing report
builders and additional study-specific gates remain the scorer's responsibility.
No PROMOTE can be obtained from this collector. Incomplete native endpoints
must stay missing, with a complete-case appendix and failure-as-error analysis
prepared by the eventual study module; the example supplies neither analysis.
