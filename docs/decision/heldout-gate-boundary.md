# HeldoutFrozen gate evaluation

`evaluateGatesFromHeldoutFrozen` in `src/gates/heldout.ts` verifies the frozen
bundle before deriving the binding pin and holdout seal. Library callers can
use `sealGateHoldoutFromFrozen` when they need those inputs separately.

The existing HeldoutFrozen bundle contains corpus, preregistration and approval.
It does not embed the analysis or GateBinding. The entry point verifies
`frozen.digest === heldoutDigest(frozen.bundle)`, then verifies the supplied
analysis against `bundle.preregistration.studyAnalysisDigest`. It derives the
binding digest from that verified analysis's `gateBinding`. Caller-supplied
binding pins and holdout seals cannot override the derived inputs.

The D29 access/v1 record names the analysis digest and first-access time. Its
analysis digest must match the frozen preregistration, and its entire contents
must match an independently retained `trustedAccessDigest`. Recomputing that
anchor from an untrusted access record defeats the boundary. The record has no
signature, run ID or frozen-bundle digest; it establishes membership in the
frozen analysis and binding, not independent clock authenticity or a specific
collector run. Frozen bundle integrity likewise relies on the host's retained
approval/evidence anchors for authenticity. No new schema or historical record
rewrite is required.

The collector forwards its frozen record to D29 scoring. Offline report probes
must supply explicit synthetic frozen/access records. A bare timestamp no
longer suffices. Every seed pins the current study entry's bytes, matching the
shared collector's source-pin contract. The entry also checks embedded digests
of the extracted gates and provenance modules. Public v6–v8 demos were re-frozen
with only scorer and dependent digest changes; corpus, gold/labels and analysis
are unchanged. See the [file-by-file disposition](README.md#d29-scorer-pin-disposition-3730-2026-10-28).
These public corpora remain ineligible for collection.

The bounded #2319 audit slice is covered by `test/unit/gates/heldout.test.ts`.
It includes stale/invalid frozen digests, edited analysis, a wrong caller
binding, fabricated/mismatched access records, missing anchors and invalid
timestamps, plus a positive byte-identical seal/report path. The parent audit
remains open.
