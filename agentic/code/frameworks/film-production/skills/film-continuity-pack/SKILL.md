---
name: film-continuity-pack
namespace: aiwg
platforms: [all]
description: Build the minimal verified character, environment, and prop reference pack required by planned shots.
triggers:
  - "film-continuity-pack"
  - "build film continuity pack"
commandHint:
  modelRole: efficiency
  modelTier: economy
---

# Film Continuity Pack

## Inputs

Read current state, story proof, required viewpoints, and original character, set, and exact-source references. Load `aiwg show template film-continuity-bible`.

## Workflow

1. Assign each reference an explicit controlling role and version. Separate sharp aesthetic and anatomy masters from blocking-only guides; a degraded guide cannot become a visual-quality master through repeated reuse.
2. Build only the angles needed by the shot plan; recurring characters follow step 7. For a fixed camera, lock environment geometry, camera position, lighting, material detail, static prop coordinates, and stable registration anchors. Additional independent views do not prove a seamless navigable environment.
3. Describe identity at the level needed for inspection: silhouette, proportions, markings, costume, handedness, and visible hand anatomy. Define directional features in character coordinates and camera view to avoid ambiguous left/right instructions.
4. Inventory props with counts, dimensions, support surfaces, and attachment endpoints. Record hand occupancy, reachable distances, drawer/door clearance, foreground/background depth, and plausible contact at required action states.
5. Preserve authentic screens, text, logos, or artwork as exact-source editable layers with provenance and crop/transform records. Keep them distinct from generated approximations.
6. Inspect full frames and native-size crops for anatomy, contact, occlusion, object count, and material detail. Register defects in current state and identify dependent shots; do not mark an attractive but physically impossible reference as ready.
7. For a recurring character in episodic work, lock the views that the planned shots and following episodes need — typically a full-body turnaround, a mouth-state sheet when visible speech is planned, hand views, and one in-scene start frame per talking character — each recorded with hash and controlling version before first motion. Require user approval where the brief records it. An optional 3D proxy (image-to-3D mesh plus fixed-camera renders) may serve as the angle authority for blocking; generated views remain references, not a validated model.

## Outputs

Produce the continuity bible, reference manifest, required view/contact crops, and a short per-shot invariant checklist. Retain editable masters and immutable originals.

## Continue or hold

Continue when the pack supports the planned camera and actions at usable quality. Hold dependent generation for known source defects or missing geometry; request new views only when the actual shot needs them. Reference approval remains bound to its inspected version.
