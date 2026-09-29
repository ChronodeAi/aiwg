# Multimodal preprocessing lineage

Status: experimental, default-off. Jev remains text-only.

`PreprocessedEvidence.v1` records how text decision input was derived from a
non-text source such as a scanned document, audio clip, video segment, or image.
It is a provenance contract for recorded extraction outputs, not an OCR, ASR,
captioning, vision, or document-processing service.

The TypeScript entry point is `resolvePreprocessedEvidence()` from
`aiwg/decision`. Host code must opt in explicitly:

1. Load a closed `PreprocessedEvidence` manifest.
2. Resolve it for a specific destination such as `jev`.
3. If the resolution is `ready`, pass only `resolution.state.text` as ordinary
   decision input.
4. Pass `resolution.receiptEvidence` as
   `DecisionEvaluationRequest.preprocessingLineage` to link the receipt to the
   lineage pins and digests.

The evaluator does not read raw media or derived text from the lineage evidence.
When `preprocessingLineage` is supplied, the `RulesetResult` is written as
`decision.aiwg.io/v1alpha2` and contains only artifact pins, source/output
digests, selected segment IDs, locator digests, quality labels/flags, counts,
duration and policy outcomes.

## Resolver checks

The resolver validates the manifest structure, source/output digests, ordered
step continuity, unique step IDs, selected segment references, transformation
links, and locator policy before releasing text. Unsupported transformations,
digest mismatches, chain cycles, missing segments, and unauthorized remote
locators fail closed.

Low-quality, truncated, incomplete, stale, or derived-egress-denied evidence
does not become an automatic pass. It resolves with status `review` and typed
reasons so the caller can route to manual review or no-action. Preprocessor
quality is stored as preprocessor evidence only; it is not Jev confidence,
calibrated risk, or decision correctness.

Raw-media and derived-text egress are evaluated separately. Raw media can be
denied for Jev while derived text is allowed. If derived text is denied for the
destination, the resolver withholds `state.text`.

## Offline fixtures

The checked-in fixture set
`test/fixtures/decision/preprocessing/multimodal-lineage-v1.json` covers:

- scanned-document OCR;
- audio transcription;
- video captions with time/frame locators;
- image description with a bounding-box locator.

`test/unit/decision/preprocessed-evidence.test.ts` is the runnable offline
example. It resolves a recorded OCR fixture, projects the derived text through
the existing D10 egress boundary, sends a text-only state to a spy Jev adapter,
and produces a normalized decision result with body-free lineage references.

## Lifecycle

Preprocessing lineage uses the common D10 surface
`preprocessing-lineage`. Raw assets, derived text, transformations, human
corrections, locators and traces inherit the shared retention, deletion,
tombstone, backup and legal-hold rules described in
[data lifecycle](data-lifecycle.md). Offline tests cover the lineage contract
and body-free receipt evidence; production rollout still needs deployment store
erasure, backup expiry, privacy approval, and live reviewer/process evidence.

## Pending before production

No live Jev calls, real held-out media data, human-reviewer workflow, production
retention backend, or privacy approval is claimed by this implementation. Those
inputs remain required before enabling this feature beyond recorded offline
fixtures.
