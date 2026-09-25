---
name: film-intake
namespace: aiwg
platforms: [all]
description: Establish a film brief, current production state, and bounded authority before development or resumption.
triggers:
  - "film-intake"
  - "film intake"
commandHint:
  modelRole: efficiency
  modelTier: economy
---

# Film Intake

## Inputs

Use the user's current objective, existing production state, supplied media, delivery requirements, and recorded authorizations. Resume from the current state rather than treating historical notes as a fresh brief.

## Workflow

1. Resolve the artifact location with `aiwg artifacts path --json --check-write`. Load `aiwg show template film-production-brief` and `aiwg show template film-production-state`; keep one controlling state record under the resolved artifact root.
2. Record audience, intended emotional effect, premise, format, approximate duration, delivery destination, and what constitutes a useful finished result. Preserve explicit constraints; mark consequential unknowns instead of inventing decisions.
3. Inventory inputs by role: aesthetic master, anatomy/character master, blocking-only guide, exact-source artwork/screen, selected performance, and historical reference. Record identifiers, versions, hashes, provenance, and observed quality. Keep originals immutable.
4. Separate authority for local planning/editing, external uploads, paid generation, delivery, and publication. Record the existing scope and remaining budget without asking again for settled permission. Distinguish an evidence hold from an action that lacks authority.
5. Identify the next bounded milestone and dependencies. Reuse current review artifacts, archive superseded directions, and mark known defects plus affected downstream assets. Discover only the adapter needed for the next operation.

## Outputs

Write the brief, input inventory, current state, and next permissible action. Approvals identify the exact version and dimension: story/blocking, visual quality, performance, motion, or delivery.

## Continue or hold

Continue independent authorized work when remaining unknowns do not affect it. Hold only dependent operations for missing material decisions, unavailable sources, contradictory controlling requirements, or absent authority. Intake completion alone does not verify source quality or authorize publication.
