---
name: film-reference-footage
namespace: aiwg
platforms: [all]
description: Source licensed reference footage, record provenance, and restyle or replace it through a preflighted route reviewed like any generation.
triggers:
  - "film-reference-footage"
  - "restyle reference footage"
commandHint:
  modelRole: efficiency
  modelTier: economy
---

# Film Reference Footage

## Inputs

Use the storyboard panel for the beat, current state, the continuity bible's controlling character and set references, recorded authority, and the `film-reference-sourcing` rule. Load `aiwg show template film-generation-receipt` for each paid run.

## Workflow

1. Take the beat from the storyboard: its events, camera, framing, duration, prop states and hand occupancy. Footage must serve that beat, not redefine it.
2. Search qualifying sources and record provenance per the `film-reference-sourcing` rule: page, file and license URLs, license version/date, clause relied on, author, retrieval date and license-snapshot sha256. Keep ambiguous or re-hosted items as mood only.
3. Trim to the beat with handles; conform fps/resolution to the timeline and delivery floor. Record the trimmed file's sha256 and extract frame 0.
4. Choose the route:
   - character replace (keeps source background: character insertion only);
   - reference animate (reference image must match the source's frame 0 in framing and pose);
   - localized restyle with an approved first frame;
   - video-to-video with references.
5. Preflight one ≤5 s representative test through `film-provider-preflight` within recorded authority before any batch.
6. Review per `film-review-gate`, with 3× crops of identity, hands, props and any recognizable source person, brand or art.
7. Record cost per usable second and the adoption verdict against the cost of generating the same beat from scratch.

## Outputs

A provenance record per source, conformed trims with hashes, run receipts, a reviewed candidate per route, and an adoption verdict with cost per usable second.

## Continue or hold

Continue when provenance is complete, the route's test passes review with no recognizable source person, and the cost per usable second is within the recorded comparison. Hold sources with incomplete or ambiguous terms, routes that fail the representative test, and any output that alters the beat's events. Footage sourcing does not authorize spend; existing bounded authority remains controlling.
