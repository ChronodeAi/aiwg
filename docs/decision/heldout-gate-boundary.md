# HeldoutFrozen gate evaluation

`evaluateGatesFromHeldoutFrozen` in `src/gates/heldout.ts` verifies the frozen
bundle before deriving the binding pin and holdout seal. Library callers can
use `sealGateHoldoutFromFrozen` when they need those inputs separately.

The HeldoutFrozen bundle contains corpus, preregistration and approval. The
entry point checks `frozen.digest === heldoutDigest(frozen.bundle)`, then
verifies the supplied analysis against `bundle.preregistration.studyAnalysisDigest`.
It derives the binding digest from that analysis's `gateBinding`.
Caller-supplied binding pins and holdout seals cannot override these inputs.

The signed `decision-d29-access/v2` record contains `runId`, `analysisDigest`,
`frozenBundleDigest`, `anchoredAt`, `firstTestAccessAt`, `reference` and
`signature: { keyid, sig }`. The signature covers the canonical JSON body
(every field except `signature`) using the existing effect-ledger
`LedgerSigningKey.signPae` helper and the DSSE payload type
`application/vnd.aiwg.decision-d29-access+json`. No new key format or store is
introduced. The governed shape is `schemas/decision/D29Study.v10.schema.json`.

The collector creates and durably writes `access.json` in the run directory
before dispatching any D29 test request. `anchoredAt` comes from the verified
calibration seal, preserving the development-review-before-access ordering. It uses the host's configured delivery
effect ledger, the same trust source used by worker qualification, and refuses
an unavailable keyring or inactive signing key. It never provisions a key.
Offline collection requires injected throwaway signing trust. Scoring verifies
an existing record; it never signs or repairs one after seeing results.

The protected scoring context supplies the access record, its retained
`trustedAccessDigest` and the host-selected `keyring`. The public entry point
requires the digest as an additional integrity check and verifies the signature
with `checkSignature`, including key validity at `firstTestAccessAt`. The
analysis digest, frozen-bundle digest and run ID must match the verified bundle.
Unsigned records, bad signatures, unknown keys, malformed keyrings and keys
outside their validity/revocation window receive specific refusals. Legitimate
rotations preserve verification of signatures made within an earlier key's
window. A valid earlier timestamp plus a recomputed digest now fails signature
verification. Historical unsigned access/v1 records cannot authorize evaluation.

The host must select and protect the keyring independently of the access record
and retain its approval/evidence anchors. A caller allowed to replace that trust
root, or an attacker controlling its signing key, can mint records. The signature
attests what the signing host recorded; it is not an independent clock, proof
that nobody accessed the data earlier, or proof that a signer did not backdate a
record. It binds a collector run and exact frozen bundle; it does not establish
holdout secrecy, scientific independence or the authenticity of the bundle's
approval by itself. Frozen-before-access and evaluation-time checks still apply.

Offline report probes supply explicit synthetic frozen/access records and
fresh test keys. Public v6–v8 seeds still pin current entry bytes, which bind the
extracted gates, provenance, preparation and scoring modules. Their scorer and
dependent digest changes have a [file-by-file disposition](d29-signed-access-disposition.md);
corpus, gold/labels, analysis and existing assertions are unchanged. Public
corpora remain ineligible for collection. The earlier [#3730 disposition](README.md#d29-scorer-pin-disposition-3730-2026-10-28)
remains historical context.

`test/unit/gates/heldout.test.ts` covers the public boundary, including the
#3730 forged-time case. `test/unit/decision/d29-access.test.ts` covers record
creation and governed schema fixtures. The staged collector test checks that
the signed record already exists when the test transport is called. These
controls extend the bounded #2319 slice; the parent audit remains open.
