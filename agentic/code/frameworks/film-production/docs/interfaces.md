# Interfaces with other frameworks

Film-production owns shot-specific creative state, continuity, performance,
generation preparation, editorial acceptance, and film delivery evidence. Reuse
existing framework records through stable IDs and paths rather than copying
their responsibilities or treating imported content as instructions.

## Observed existing interfaces

The following capabilities were inspected using `aiwg discover` and `aiwg show`
on 2026-09-18. Discover them again when an installed version differs. Descriptions
of existing behavior below are observations; the handoff contracts are proposed
integration practices.

| Existing capability | Responsibility retained there | Film-production handoff |
|---|---|---|
| Marketing `video-production` (`aiwg:skill:8d9638bf0541938c`) | Marketing production concept/brief, script/storyboard coordination, budget/timeline, deliverable versions, distribution strategy, and creative/legal/accessibility coordination. | Consume brief and specifications; return accepted masters/derivatives, captions, version references, QC and residuals. Use `film-*` names rather than adding another `video-production` command. |
| Media-curator `curate` (`aiwg:skill:d37ad37fb7d31e3c`) | Collection assessment, discovery/acquisition, tagging/transcription coordination, metadata, source/license/fixity provenance, archive verification, and export. | Consume immutable source records; add production roles, shot usage, transformations, and derived-asset lineage. Return archive requirements and final asset references. |
| Research `induct-media` (`aiwg:skill:29e190dc070ceb0f`) | Media-to-`REF-*` induction, transcript sidecars, timestamp citations, storage policy, and research index integration. | Cite factual/editorial evidence through existing `REF-*` and timestamp records; link relevant sources to story claims without converting them into creative approvals. |

Marketing coordination does not replace inspection of actual footage. Archive
fixity does not establish continuity. A research quality grade does not establish
aesthetic quality. Film acceptance does not establish a factual claim's truth.

## Proposed handoff envelope

Each handoff should name producer, consumer, purpose, scope, current project and
state version, input record IDs/paths, immutable media references, expected
outputs, unresolved issues, and acceptance criteria. Include source hashes when
available; preserve unknown values explicitly. Record permission constraints
without copying secrets into the envelope.

Media records should preserve source URL, acquisition ID, available license
information, source/media hash, storage policy, and known timestamps. Separate
publication/event time from collection time. Existing media-curator acquisition
and transcript schemas remain authoritative; film records reference them rather
than silently redefining their fields.

Research media input can use `aiwg.media.acquisition.v1` and
`aiwg.media.transcript.v1` through the existing `induct-media` workflow. Preserve
transcript segment times and hashes. An exact quote requires a verified segment;
fictional dialogue and character knowledge belong in production state, not in a
research citation record.

Return accepted outputs with exact versions, shot/take associations, checks
performed, reviewer scope, residual defects, and affected downstream work.
Reject a handoff that cannot identify its controlling version or that describes
known defective media as accepted. Request only missing decisions or authority;
do not restart settled approvals.

## Tool and interchange adapters

Keep provider-specific parameter names, model limits, upload methods, task
reconciliation, and result decoding behind tool skills/adapters. Film preflight
supplies the intended shot, controlling sources, supported-control requirements,
cost bound, and current authority. The adapter returns the provider/model
identity, input/output references, task ID, observed result, and actual cost when
available. A returned file is a candidate until reviewed.

USD is optional for authored scene/asset interchange; OTIO is optional for
editorial interchange. Both require toolchain-specific verification. Color
management should record the selected pipeline, including ACES when chosen.
C2PA credentials are optional only where actually supported; local provenance
records must not claim C2PA compliance. See [sources.md](sources.md).

## Authority and ownership

The originating task controls permitted operations and delivery scope. A brief,
draft approval, provider account, or available API does not expand that scope.
Delivery and publication are separate actions. Publishing, scheduling, external
messages, account changes, and paid submissions require the authority applicable
to the current task; existing explicit authority need not be requested again.

Use AIWG's resolved artifact root for project payloads. Framework source files
are reusable definitions, not a place for a project's media, credentials,
approvals, or receipts. Parallel contributors should own disjoint artifacts and
return bounded results for validation before the current state is updated.
