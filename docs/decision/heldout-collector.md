# Shared held-out study collector

The experimental collector is default-off. It collects synthetic observations
for source-controlled D17 and D29 study modules; it never promotes a model,
changes a workflow, approves an SDLC gate or claims a study has passed. The
checked-in example is a two-subject plumbing demonstration, not held-out data.
No live collection was performed for this implementation (#2611, #2622, #2778).

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

The closed v1 corpus, preregistration, approval, baseline, spend-event,
frozen-input, calibration-phase, attempt, event and summary schemas are under
`schemas/decision/Heldout*.v1.schema.json`; the current spend-head schema is
`HeldoutSpendHead.v2.schema.json`. Definitions and receipts also pass the existing
decision validators. Unknown fields, null price rates/fees, malformed calibration
bindings, changed approval pins, duplicate payloads, cross-split families and
non-synthetic provenance fail before dispatch.

Approval binds the corpus and preregistration, requested/served `jev-1.13.0`,
all execution definition/ruleset/binding/projection pins, adapter version,
calibration mode/phase and its required digests, resolver file digest, clean exact source commit, CI evidence
reference, reviewer, titan workspace, provider terms reference and run ceilings.
CI and provider terms references are operator attestations, not remotely
verified results. The approval's closed `calibration` block replaces the former
bare `calibrationDigest`; old approvals must be refreshed. No fixture digest or
hash of a plan substitutes for a genuine D09 artifact.

### Three calibration modes

| Approval `calibration` | Preregistration `calibration` | Permitted collection |
| --- | --- | --- |
| `{mode: 'uncalibrated-diagnostic'}` | `{scope: 'uncalibrated-diagnostic', allowedModes: ['uncalibrated-diagnostic']}` | All declared rows; diagnostic scoring only |
| `{mode: 'staged', phase: 'calibration'}` | `{scope: 'calibrated', allowedModes: ['staged'], calibrationPhaseSplits: ['tuning', 'calibration']}` | Only the declared calibration-phase splits; never test |
| `{mode: 'staged', phase: 'test', calibrationArtifactDigest, calibrationPhaseRecordDigest, priorApprovalDigest}` | The same immutable staged preregistration | Only test rows, after verification of the sealed calibration phase |
| `{mode: 'artifact', calibrationArtifactDigest}` | `{scope: 'calibrated', allowedModes: ['artifact']}` | All declared rows using an independent pre-existing artifact binding |

A calibrated preregistration can allow both `staged` and `artifact`. Declaring
`staged` requires a nonempty, unique `calibrationPhaseSplits` drawn only from
`tuning` and `calibration`; either or both can be declared. Diagnostic scope
allows only diagnostic mode. Unknown fields, null artifact digests, missing
phase pins and unregistered modes fail closed. Every required digest must have
the `sha256:` form. Artifact bindings establish identity only: the collector
does **not** load, validate, qualify or register a D09 artifact. Even a digest
matching a known fixture receives no validity or compatibility claim.

Dry-run reports `calibration`, `rowsInScope`, phase-only `maximumAttempts`,
`reservedTokens` and `reservedUsdMicros`, plus the remaining global `allowance`.
Worst-case estimates include the preregistered terminal retries. Test-phase
dry-run also requires the matching seal. A feasibility estimate is not a
collection approval or a D09 qualification.

### Staged runbook

1. Freeze the complete corpus, split memberships and preregistration before
   either phase. Approve `{mode: 'staged', phase: 'calibration'}` with real
   source, pricing and operator attestations. No calibration artifact is needed
   to collect this phase.
2. Collect only the preregistered tuning/calibration splits. A session
   checkpoint is not a phase boundary: resume with a new approved run ID and
   the same corpus, preregistration, budget and original spend floors.
3. When every in-scope row is terminal, the collector exclusively writes and
   fsyncs `runs/RUN_ID/calibration-phase.json`. Successful requests, deterministic
   local rows and terminal measurement failures count as terminal. Unvisited
   rows skipped by a slice tolerance, checkpoints, stopping failures and
   unresolved reservations do not seal the phase. A seal proves completion of
   collection, not adequate samples or acceptable quality.
4. Fit the mapping, then separately **qualify and register the D09 artifact**
   through the existing calibration registry and qualification harness. A
   fitted mapping alone is not D09 qualification. Representative data,
   sample/slice sufficiency, compatibility, integrity, review and qualification
   evidence still have to satisfy D09.
5. Anchor the genuine artifact digest, `heldoutDigest(calibration-phase.json)`
   and the digest of the calibration approval that owns that seal in protected
   operator records. `summary.calibrationPhaseRecordDigest` supplies the seal
   digest; it is null for an incomplete calibration phase.
6. Approve the test phase with those three pins in `calibration`. The prior
   approval must be a calibration-phase approval for the same corpus and
   preregistration. The test approval keeps the shared budget and initial
   spend floors. No automatic approval transition or artifact fitting occurs.
7. Collect test rows. Before planning or dispatching them, the collector rereads
   the seal, its frozen approvals and complete journal/attempt lineage. It
   records `frozen.testPhaseAccessAt`, strictly later than `sealedAt`; equal,
   earlier or missing times refuse access. This is a host-clock observation,
   not an independent timestamp authority.
8. Score with the test approval and trusted evidence/integrity pins. The scorer
   receives the exact `approvedCalibration` binding and must compare its
   artifact digest to the trusted D09 artifact it actually uses, then apply
   existing D09 validation/compatibility and native study gates.

The seal is closed/versioned and binds all calibration-phase rows, approval,
corpus, preregistration and the complete prior-run journal/attempt lineage.
A changed seal, changed lineage, missing prior approval or changed study pins
refuses test access and scoring. Protected storage and separately anchored
approval digests remain necessary; local hashes are not signatures.

The offline example additionally exports `prepareStaged(seed)`. It constructs
three fictional rows, never a D09 artifact or a live approval:

```bash
node --import tsx --input-type=module -e \
  "import {prepareStaged} from './agentic/code/addons/decision-engine/examples/heldout-collector-offline.mjs'; console.log(JSON.stringify(await prepareStaged('demo')))"
```

### Reservations and shared spend

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
reservation must fit the remaining allowance. Every mode fixes its 80%
thresholds against the first approved study budget and original baseline
remainders, then subtracts accumulated charges. Both phases and every resume
share that allowance; switching mode, phase, corpus or run ID never applies 80%
anew to a remainder. The collector rejects an approval whose budget
cannot cover even one of its planned calls (including a USD 0.0005 approval
with a larger reservation). Calls and reserved tokens also stop at 80% of the
first approval, cumulatively across all modes, phases and resumes.

The collector records each operator floor once, with its approval digest and
the counter's genesis digest, in
`research/qualification/heldout/baselines/{D17,D29,portfolio}.json` beneath the
canonical artifact root. The initial floors must include spending outside this
collector; subsequent approvals repeat the original floors. Each study baseline
also pins the first approval's closed USD/call/token `budget`; the portfolio
baseline has `budget: null` because it has no separate study allowance. Admission
and dry-run compare every subsequent approval to the stored study budget,
independently of corpus identity or surviving run directories. Any changed
budget is refused before credential access; existing thresholds are never
rewritten by an approval.

A separate `research/qualification/heldout/spend-counter.jsonl` records every
reservation and settlement across both studies. Each append is hash-chained and
fsynced; settlement only adds observed excess and never subtracts a reservation.
The counter stores cumulative collector charges and reserved token counts, and derives USD, call and token totals per study.
For each scope, accounted spend is the maximum of its baseline, its baseline
plus counter charges, and its baseline plus scanned run charges. Deleting a run
directory, or its events and summary together, therefore cannot restore allowance.
The counter also preserves call/token allowance and unresolved/stopped-attempt status after such deletion.
Lost run receipts cannot be reconstructed from this compact counter.

`spend-head.json` independently anchors the latest sequence/digest and the
complete set of baseline content digests. Its v2 record is replaced atomically
and its directory fsynced after every counter append and first approval for a
study, including an approval that dispatches no calls. Baselines are synced
before publishing their head pins. Replacing, adding or deleting a baseline
fails verification even after every run directory is deleted; a matching new
approval cannot authorize changed baseline contents. Both dry-run and collection
verify these pins before credential access.

A surviving baseline with a missing, truncated or broken counter, a mismatched
head, or an interrupted head update refuses further collection with
`spend-counter-operator-repair-required`. This includes truncation to a valid
chain prefix after deleting all run directories. Preserve the counter, head,
baselines and remaining run evidence; an operator must reconcile them against
protected backups and provider billing. Never delete these files to restart.
There is no automatic repair, migration or baseline reset. Old baselines without
a genesis pin or the required budget field also require reconciliation; missing,
null or malformed study budgets fail closed. Legacy v1 heads without baseline
pins also require operator reconciliation; they are never automatically upgraded
from unverified baseline files. Dry-run uses the same accounting
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
The additive `heldout-lamp-splits/v1` generator appends an explicit
`:tuning`, `:calibration` or `:test` split; its full output is also reproduced.
Whitespace, instruction punctuation, non-ASCII text and overlong components
are rejected. The dispatched world name is `w-` followed by 16 hex digits
derived from the seed digest, so even permitted seed text stays out of model-visible
state. A bounded identifier still needs synthetic provenance review;
this constraint does not prove that an identifier has no external meaning.
The registry includes the fictional `heldout-lamp/v1` and
`heldout-lamp-splits/v1` examples and the frozen D29 `d29-synthetic/v1` generator. The current
[D29 study](d29-heldout-study.md) uses the additive `d29-synthetic/v2` registry
entry, with 2,000 subjects, ten slices and balanced wording/trap variants.
The `single` and `local` row seeds encode each version’s fixed split layout;
malformed layouts and out-of-range indices fail regeneration. D17 still
requires a reviewed generator addition and fresh corpus pins.
This proves reproducibility, not held-out quality or correctness of the gold.
These experimental v1 contracts are tightened in place: earlier unproven rows
must be regenerated, and approvals/attempt token reservations must be refreshed.
The calibration block, frozen access time, summary seal pin, spend-counter
reserved tokens and baseline budget are required by the tightened v1 schemas. Existing ledgers need
operator reconciliation; there is no silent conversion or spend reset.
Generator changes require fresh corpus pins; existing ledgers are not migrated
automatically across these experimental contract changes.

`scoreHeldoutStudy` rechecks trusted approval/evidence/gold/scorer
pins and validates digest-bound upstream eval-integrity before calling the
local scorer. It rechecks each journal's phase membership, and test-phase
scoring re-verifies the seal and recorded access time. The scorer receives only
the approved phase's `corpus.rows` and attempts; `preregistration.corpusDigest`
still identifies the full frozen corpus. Gold is caller-supplied local data,
not a model-visible input or a mechanism for isolating trusted host code.

`HeldoutStudyModule.score` receives `approvedCalibration: HeldoutCalibration`
(the exact approved mode/phase and digests) and `calibrated: false | null`.
Diagnostic mode and pre-fit calibration-phase collection pass `false`; their
scorers must return `calibrated: false`; `d09Qualified` and `calibratedGate`
must also be false when present. Conflicting or missing calibration declarations
and a structured `decision: 'PROMOTE'` are refused.
Artifact/test mode passes `null` (unknown), because the collector has not
validated D09. The wrapper reports the binding,
`calibrationArtifactValidation: 'not-performed'`, `d09Qualified: false` and `calibratedGate: false`. These are
collector claims; native study diagnostics require their own trusted artifact
validation. A scorer is trusted host code; arbitrary diagnostic prose is not
validated as a qualification claim. The library wrapper always returns HOLD or preserves ROLLBACK,
including when artifact/test diagnostics contain a proposed PROMOTE. Diagnostic
and pre-fit calibration scorers cannot return that structured decision. A scorer callback is
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
| Staged D09/test handoff | Sealed real calibration observations, genuinely qualified/registered D09 artifact, protected artifact/seal/approval anchors and human test-phase approval |
| Any live collection | Priced approval with real evidence references, clean source/CI attestation, canonical root, actual prior spend, resolver pin, synthetic privacy approval and provider terms record |
| Promotion or production rollout | All native and external thresholds evaluated against complete data, compatible calibration, protected eval-integrity evidence and separate operator approval |

The collector preregistration pins a **separate study analysis digest**. It does
not implement D17/D29 quality thresholds or economics. Their existing report
builders and additional study-specific gates remain the scorer's responsibility.
No PROMOTE can be obtained from this collector. Incomplete native endpoints
must stay missing, with a complete-case appendix and failure-as-error analysis
prepared by the eventual study module; the example supplies neither analysis.
