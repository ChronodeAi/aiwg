---
name: film-review-gate
namespace: aiwg
platforms: [all]
description: Review film candidates for requested changes and regressions before version-bound promotion.
triggers:
  - "film-review-gate"
  - "review film quality gate"
commandHint:
  modelRole: reasoning
  modelTier: standard
---

# Film Review Gate

## Inputs

Read current state, candidate and controlling source versions, requested change, shot invariants, known defects, and existing acceptance scope. Load `aiwg show template film-review-record`.

## Workflow

1. State the review dimension and exact asset version: story/blocking, visual quality, performance, motion, edit, or delivery. Carry forward unaffected acceptance while reopening dimensions changed by the revision.
2. Inspect the target change and the whole frame. Check anatomy, object counts, prop identity/scale, hand occupancy, contact/support, attachment endpoints, reach/clearance, depth, registration, lighting, source text/art, and material detail where relevant.
3. Use native-size crops at defects and occlusion boundaries plus the full-frame comparison. For fixed-camera shots, compare stable anchors or overlays. Do not infer preserved detail from resolution or encoding alone.
4. For motion, play the actual clip and frame-step critical transitions. Walk the shot record's event list frame by frame: each listed contact happens once, on the listed target, in order; counts and state changes match; nothing appears, disappears, or changes without its causing event. For performance and edit, listen and view in sequence. Record the range actually inspected; contact sheets, thumbnails, and tool success messages cannot substitute for playback.
5. Review every cut boundary in playback at real speed, at least one second before and after each cut, then frame-step the join. Check pointer target, finger position, key/button state, prop art, location and count, and that no action repeats (double press), is skipped, or teleports. Before/after stills alone cannot pass a cut.
6. For inserted exact art and in-world screen text, inspect native-size crops across the whole clip, not only the final frame: tracking fit, perspective, occlusion and containment order (for example art inside a folder must stay behind its front edge), edge blending, and legibility.
7. Compare adjacent shots for causal state, dialogue continuity, prop location, and knowledge/reveal order. Register self-detected failures in current state, including affected downstream work. When the user finds a defect the review missed, add its class to the checklist for all remaining shots and re-check shots already passed for the same class.
8. Label the result accurately: generated, candidate with residuals, or verified for named checks. Apply an evidence hold to known relevant defects; do not convert broad gallery approval into clearance of an acknowledged problem.
9. Continue corrections already authorized. Ask only for an unresolved material creative decision or genuinely missing authority, not automatic confirmation after each review.

## Outputs

Update one compact review package with the candidate, relevant crops/playback, passed checks, residuals, and next action. Keep superseded versions traceable.

## Continue or hold

Promote only inspected dimensions without unresolved blocking defects. If inspection is unavailable, mark the limitation and retain candidate status. Documentation records the gate; these instructions do not install automatic enforcement.
