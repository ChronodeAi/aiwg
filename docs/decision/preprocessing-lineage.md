# Multimodal preprocessing lineage

Status: experimental, default-off. Jev remains text-only.

`PreprocessedEvidence.v1` records how text decision input was derived from a
non-text source such as a scanned document, audio clip, video segment, or image.
It is a provenance contract for recorded extraction outputs, not an OCR, ASR,
captioning, vision, or document-processing service.

The TypeScript entry point is `resolvePreprocessedEvidence()` from
`aiwg/decision`. Host code must opt in explicitly:

1. Load a closed `PreprocessedEvidence` manifest.
2. Resolve it for the destination that will receive the derived text. That is the
   D10 projection policy's provider and origin, for example
   `{ "provider": "jev", "origin": "https://api.typesafe.ai" }`. For an adapter
   that declares `egress: { mode: "none" }` and runs without a projection policy,
   it is `{ "provider": <adapter id>, "origin": PREPROCESSING_LOCAL_ORIGIN }`
   (`local://no-egress`).
3. If the resolution is `ready`, pass only `resolution.state.text` as ordinary
   decision input.
4. Pass `resolution.receiptEvidence` as
   `DecisionEvaluationRequest.preprocessingLineage`, and the host's current
   manifest records (plus optional D10 lifecycle state) as
   `DecisionEvaluationRequest.preprocessingVerification`.

The evaluator does not read raw media or derived text from the lineage evidence.
When a non-empty `preprocessingLineage` is supplied, the `RulesetResult` is
written as `decision.aiwg.io/v1alpha2` and contains only artifact pins,
source/output digests, the authorized destination, selected segment IDs,
locator/text/preprocessor-identity digests, closed quality source/flags,
quality profile/label digests, retention/residency digests, counts, duration,
policy outcomes and the evaluator's `dispatchGate` verdict. An empty lineage (no
references and no traces, as returned by `resolvePreprocessedEvidence([])`) is
treated exactly as absent.

## Resolver checks

The resolver validates the manifest against the closed JSON schema (formats
included), so it never accepts what the schema rejects. It also checks the media
type for the extraction kind, source (when bytes are supplied) and output
digests, ordered step continuity, unique step and segment identities, selected
segment references, transformation links and locator policy before releasing
text.

Each segment carries an `outputRange`: a UTF-8 byte range inside the
digest-verified `output.value`. The segment `text` must equal that slice
byte-for-byte, ranges must follow ordinal order without overlap, and the
resolver releases the slices cut from the verified output, in source order. A
segment whose text is not in the verified output is rejected even when its own
`textDigest` matches.

Unsupported transformations, digest mismatches, real chain cycles, missing
segments, wrong media types, missing media-specific locators, duplicate segment
IDs/ordinals, and remote-url locators (for the source and for
`output.reference`) fail closed. An identity step, whose input digest equals
its output digest, must be declared `noOp: true`. A `noOp` step that changes
content, or a `noOp` extraction step, is rejected. No-op step IDs are recorded
in the lineage trace as `noOpStepIds`.

Human correction is never a preprocessing step kind. It enters only as an
append-only `human-correction` transformation event with reviewer, rationale
and a link to the previous output (ID, version, digest). Each correction takes
the current output as input, and the final `output.version` must be newer than
every corrected version. The original extraction steps stay unchanged. The
correction events are part of the preprocessing identity digest, so a stored
reference to the pre-correction output becomes stale.

Low-quality, truncated, incomplete, stale, policy-limited, untrusted
(`policy.trust: "untrusted"`), derived-egress-denied, tombstoned or legal-held
evidence resolves with status `review` and typed reasons. Preprocessor quality
is stored as preprocessor evidence only; it is not Jev confidence, calibrated
risk, or decision correctness. Free-text quality profile/label and
retention/residency values stay out of receipts and traces and are represented
as digests. There is no option to retain derived text or raw media in receipts.

## Evaluator gate

`evaluateDecisionRuleset()` gates a non-empty lineage after request validation
and before receipt acquisition, credential resolution and adapter dispatch:

- **Refused** (`error` / `data-boundary-denied`, no evaluations): the lineage is
  malformed; a reference's recorded destination differs from the D10 projection
  provider/origin of any target that could be dispatched (including fallback
  targets); derived egress is not authorized for that destination; or the
  destination cannot be bound (`unprojected-local` opt-out or a projection
  resolver that fails).
- **Review** (`review` / `insufficient-information`, no evaluations, no
  outcome): the lineage status is not `ready`; any trace is under review or
  names a reason; any reference carries a blocking quality flag or untrusted
  trust; traces are missing or misaligned; no `preprocessingVerification` was
  supplied; the current manifest is unavailable (deleted or missing); a stored
  reference is stale against the current manifest
  (`checkPreprocessedEvidenceReference`); or the D10 lifecycle state tombstones
  or holds a dependent record.
- **Allowed**: the request continues on the normal projection and dispatch
  path.

The verdict is recorded as `preprocessingLineage.dispatchGate`. A result cache
is refused for requests that carry lineage, because a cache hit would bypass the
gate. The evaluator cannot prove that the text in `input` is the text the
lineage was resolved from; host code must pass `resolution.state.text`
unchanged.

## Offline fixtures

The checked-in fixture set
`test/fixtures/decision/preprocessing/multimodal-lineage-v1.json` covers:

- scanned-document OCR;
- audio transcription;
- video captions with time/frame locators;
- image description with a bounding-box locator.

`agentic/code/addons/decision-engine/examples/preprocessing-lineage-offline.mjs`
is the packaged runnable offline example. It resolves a recorded OCR fixture,
sends text-only state to a local no-egress decision adapter, and produces a
normalized decision result with body-free lineage references. The unit test
`test/unit/decision/preprocessed-evidence.test.ts` runs the same example through
the source runtime.

Text-native requests without a manifest are compared byte-for-byte against
`test/fixtures/decision/preprocessing/text-native-golden-v1.json`, which was
generated from origin/main's runtime with `generate-text-native-golden.ts`.

## Lifecycle

Preprocessing lineage uses the common D10 surface `preprocessing-lineage`.
`preprocessingLifecycleReferences(manifest)` returns the opaque lifecycle
references for the manifest, its source asset, every preprocessing step and
transformation event, and its output. Hosts register them as the owning
subject's `links()`, so `eraseDecisionSubject()` tombstones them with the rest
of the subject and `restoreDecisionSubjectBackup()` refuses to restore them.
Identical sources or transformations map to the same opaque IDs, so one
tombstone invalidates every dependent manifest.

Passing that lifecycle state (`subject`, `now`, `tombstones`, `holds`) to the
resolver or to `preprocessingVerification.lifecycle` makes tombstoned records
resolve to `review` with `lifecycle-unavailable` and no released text. A legal
hold on the subject's `preprocessing-lineage` surface resolves to `review` with
`legal-hold`. The evaluator routes either to review before dispatch. A deleted or
unavailable manifest is never replaced by stale derived text for automatic
action.

Production rollout still needs deployment store erasure wiring, backup expiry
configuration, privacy approval, and live reviewer/process evidence.

## Pending before production

No live Jev calls, real held-out media data, human-reviewer workflow, production
retention backend, or privacy approval is claimed by this implementation. Those
inputs remain required before enabling this feature beyond recorded offline
fixtures.
