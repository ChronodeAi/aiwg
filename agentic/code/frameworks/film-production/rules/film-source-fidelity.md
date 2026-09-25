---
id: film-source-fidelity
name: Film Source Fidelity
description: Preserve immutable masters and authentic source pixels across film derivatives and edits.
enforcement: high
---

# Film Source Fidelity

## Scope

Applies to imported references, generated stills, composites, motion inputs, exact-source art/screens, and derivative exports.

## Requirements

- Label reference roles explicitly: aesthetic master, anatomy/character master, blocking-only guide, exact-source asset, selected performance, or historical reference. Record identity, version/hash, provenance, and the requirement each controls.
- Preserve original native files. A degraded blocking guide must never replace a sharp quality master. Pixel dimensions, PNG encoding, or large file size do not prove retained detail.
- Keep authentic text, screenshots, logos, and artwork as exact-source editable layers when identity matters. Record source location, collection date, crop, and transformation as available. A generated approximation is not an authentic screenshot or unchanged source artwork. Every visible copy of identity-critical art in motion must be the exact source, placed with a tracker; it must respect occluders and containment order throughout the clip. In-world screen text is tracked to its screen and fit-checked on native-size crops for the whole clip.
- Use supported localized edits or native layers for small repairs when authorized. Inspect outside-mask preservation and compositing boundaries. Do not repeatedly regenerate a whole image to repair a small defect while silently accepting unrelated changes.
- For new camera geometry, produce a suitable reference rather than forcing flat layers through unsupported motion. Record supported perspective and tracking limits.
- Record provider-required conversions and inspect derivatives for visible loss. Diagnose quality at the source before blaming a downstream encoder; higher export bitrate cannot restore already-lost detail.
- After two failures of the same defect with the same method, stop that loop, diagnose the constraint, and change the permitted method or report the blocker. For tracking, rotoscoping, and cleanup, escalate to the verified editor's native tools (planar/point tracking, AI-assisted roto masks, warp/paint cleanup) before writing custom per-frame code; per-frame color thresholds and frame-by-frame inpainting are a last resort. A safety rejection must not be routed around.

## Required response

Place known source-quality failures on hold and mark dependent assets. Continue from a verified master only after relevant fidelity checks pass; preserve rejected candidates for traceability without allowing them to become controlling inputs.
