---
name: film-delivery
namespace: aiwg
platforms: [all]
description: Package an accepted film, editable sources, and verified export evidence within the requested delivery scope.
triggers:
  - "film-delivery"
  - "deliver film package"
commandHint:
  modelRole: efficiency
  modelTier: economy
---

# Film Delivery

## Inputs

Read the brief, current state, final review record, editable timeline, exact-source assets, and requested delivery destination. Load `aiwg show template film-delivery-record`.

## Workflow

1. Resolve the required deliverables: master format, viewing copy, aspect ratio, resolution, frame rate, audio layout, captions, editable project, and any source package. Include only items needed by the requested scope.
2. Confirm the exact timeline/export version has passed its relevant review dimensions. Keep unresolved issues visible; a user-requested draft delivery can proceed as a labeled draft without becoming final quality acceptance.
3. Verify export identity, duration, complete intended range, dimensions, codec, frame rate, audio presence/channel layout, and file readability. Play the delivered file, including every cut boundary at speed, transitions, quiet passages for background noise, and the ending, rather than relying solely on metadata or the editor's render status.
4. Package the editable project and required dependencies with source/version mappings. Preserve exact-source layers and selected performances. Check relinking or reopen the package where the tool supports it; disclose any portability limitation that remains untested.
5. Record hashes, filenames, sizes, export settings, playback checks, known residuals, and actual delivery location. Link the delivery record from the single current production state.
6. Deliver through the already authorized channel. Local export, external upload, recipient delivery, and public release are separate actions; neither final approval nor a successful render implies publication or scheduling authority.

## Outputs

Provide the requested film files, editable handoff, compact delivery record, and a clear completion status tied to those versions.

## Continue or hold

Complete when requested files are accessible and verified for the agreed scope. Hold only the unsupported or unauthorized delivery action while finishing independent packaging. Never claim publication, recipient receipt, or full portability without direct evidence.
