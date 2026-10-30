---
id: film-reference-sourcing
name: Film Reference Sourcing
description: Use third-party reference footage only with recorded license provenance that permits modification, publication and AI processing.
enforcement: high
activation: bound
summary: Use third-party reference footage only with recorded license provenance permitting the intended modification, publication, and AI processing.
bound_to:
  agents: [film-producer, film-story-director, film-scene-supervisor, film-continuity-supervisor, film-editor-sound-supervisor, film-qc-reviewer]
  skills: [film-reference-footage, film-reference-edit, film-provider-preflight, film-continuity-pack, film-motion-coverage, film-delivery]
  flows: [film-develop, film-design, film-previs, film-generate, film-finish, film-deliver, film-resume, film-revise-with-impact]
---

# Film Reference Sourcing

## Scope

Applies to stock, archive, found and platform-hosted footage or images used as mood references, motion sources, restyle inputs or character-replacement plates.

## Requirements

- Before any source is uploaded to a generation service, confirm from that item's own license and the platform terms that (1) modification and publication in the intended channel are permitted, (2) processing by third-party AI or generation services is not prohibited, and (3) identifiable people, brands and art are cleared or not recognizable in the output.
- Record page URL, file URL, license URL, license version/date, the clause relied on, author, retrieval date, and a sha256 of a saved license-page snapshot.
- If terms are silent or ambiguous about AI processing, use the item for mood only, or use owned or CC0/public-domain footage.
- Re-hosting and discovery platforms (for example Pinterest) are for mood and discovery only; trace each item to its origin and apply this rule to the origin.
- Reject any output in which a source person remains recognizable.

## Required response

Hold any upload or generation whose source lacks a complete provenance record or whose terms do not clearly permit the intended use; keep the item as mood reference only or replace it with owned or CC0/public-domain footage. Reject outputs with a recognizable source person, brand or artwork regardless of other quality. Continue unaffected authorized work.
