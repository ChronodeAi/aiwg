# Multimodal preprocessing lineage

Status: experimental, default-off. Jev remains text-only.

`PreprocessedEvidence.v1` records how text decision input was derived from a
non-text source such as a scanned document, audio clip, video segment, or image.
It is a provenance contract for recorded extraction outputs, not an OCR, ASR,
captioning, vision, or document-processing service.

The TypeScript entry point is `resolvePreprocessedEvidence()` from
`aiwg/decision`. Host code must opt in explicitly:

1. Load a closed `PreprocessedEvidence` manifest.
2. Resolve it for a specific destination object containing the D10 provider and
   origin, for example `{ "provider": "jev", "origin": "https://api.typesafe.ai" }`.
3. If the resolution is `ready`, pass only `resolution.state.text` as ordinary
   decision input.
4. Pass `resolution.receiptEvidence` as
   `DecisionEvaluationRequest.preprocessingLineage` to link the receipt to the
   lineage pins and digests.

The evaluator does not read raw media or derived text from the lineage evidence.
When `preprocessingLineage` is supplied, the `RulesetResult` is written as
`decision.aiwg.io/v1alpha2` and contains only artifact pins, source/output
digests, selected segment IDs, locator/text/preprocessor-identity digests,
closed quality source/flags, quality profile/label digests, counts, duration and
policy outcomes.

## Resolver checks

The resolver validates the manifest structure, media type for the extraction
kind, source/output/segment text digests, ordered step continuity, unique step
and segment identities, selected segment references, transformation links,
human-correction reviewer/rationale/version links, and locator policy before
releasing text. It releases only the selected segments' text in source order.
Unsupported transformations, digest mismatches, real chain cycles, missing
segments, wrong media types, missing media-specific locators, duplicate segment
IDs/ordinals and unauthorized remote locators fail closed. Explicit no-op
identity steps are allowed and remain recorded as preprocessing steps.

Low-quality, truncated, incomplete, stale, or derived-egress-denied evidence
does not become an automatic pass. It resolves with status `review` and typed
reasons; the evaluator also downgrades any otherwise completed ruleset result
with review lineage to `review`/`insufficient-information` without an outcome.
Preprocessor quality is stored as preprocessor evidence only; it is not Jev
confidence, calibrated risk, or decision correctness. Free-text quality profile
and label values stay out of receipts by default and are represented as digests.

Raw-media and derived-text egress are evaluated separately against the provider
and origin destination before any adapter credential resolution. Raw media can
be denied for Jev while derived text is allowed. If derived text is denied for
the destination, the resolver withholds `state.text`.

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

## Lifecycle

Preprocessing lineage uses the common D10 surface
`preprocessing-lineage`. Raw assets, derived text, transformations, human
corrections, locators and traces inherit the shared retention, deletion,
tombstone, backup and legal-hold rules described in
[data lifecycle](data-lifecycle.md). Offline tests cover cascading
deletion/tombstone and legal hold for the `preprocessing-lineage` surface, plus
body-free receipt and trace evidence. Production rollout still needs deployment
store erasure wiring, backup expiry configuration, privacy approval, and live
reviewer/process evidence.

## Pending before production

No live Jev calls, real held-out media data, human-reviewer workflow, production
retention backend, or privacy approval is claimed by this implementation. Those
inputs remain required before enabling this feature beyond recorded offline
fixtures.
