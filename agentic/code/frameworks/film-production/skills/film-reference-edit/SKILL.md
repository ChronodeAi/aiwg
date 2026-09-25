---
name: film-reference-edit
namespace: aiwg
platforms: [all]
description: Repair a film reference while preserving its approved identity, source layers, and scene invariants.
triggers:
  - "film-reference-edit"
  - "edit film reference"
commandHint:
  modelRole: efficiency
  modelTier: economy
---

# Film Reference Edit

## Inputs

Read the current reference version, correction request, continuity bible, exact-source layers, known defects, and relevant authorization. Load `aiwg show template film-review-record` and, for inference, `aiwg show template film-generation-receipt`.

## Workflow

1. State the precise defect and the invariants that must survive the repair. Compare the current image with its immutable sharp master before diagnosing lost detail as a file-format or export problem.
2. Discover the supported editing adapter. Prefer localized masks or editable native layers for small defects, screens, lettering, and exact art when permitted by the user's workflow. Preserve source pixels for identity-critical content instead of generating semantic lookalikes.
3. For fixed-camera work, preserve geometry and static prop registration. If a new viewpoint requires new geometry, create an appropriate master rather than forcing a flat layer through an unsupported camera move.
4. Make a bounded versioned edit. Record method, controlling references, changed region, transformations, and any cost. After two failed attempts at the same defect, diagnose ambiguity, conflicting references, occlusion, resolution, or unsupported controls and change the permitted method before trying again; for tracked, masked, or cleanup repairs in motion, move to the editor's native tracker, roto, or paint tools before custom per-frame code.
5. Inspect the changed region and a full-scene regression checklist: anatomy, prop counts, attachment paths, hand contacts, support, depth, lighting, text/art identity, and material detail. Compare outside-mask pixels and native-size boundary crops; prompts alone do not establish preservation.
6. Update current state with residuals and affected downstream assets. Keep the edit as a candidate until its relevant checks pass.

## Outputs

Return a versioned editable reference, compact comparison evidence, review record, and generation receipt where applicable.

## Continue or hold

Promote only the inspected version and dimensions. Keep known defects on quality hold; an attractive repair or broad gallery approval does not clear an acknowledged regression. Continue independent work while a dependent reference remains held.
