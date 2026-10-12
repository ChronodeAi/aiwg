---
id: film-continuity
name: Film Continuity
description: Preserve physical identity, object states, geometry, and causal transitions across film shots.
enforcement: high
---

# Film Continuity

## Scope

Applies to continuity packs, shot records, still repairs, motion generation, and adjacent-shot review.

## Requirements

- Represent every interacting prop with identity, count, location, scale, orientation, support, and start/intermediate/end states. A state change moves an object; it does not authorize duplication or transformation into another object.
- Assign hand occupancy and inspect visible anatomy against the character's controlling references. Check grasp, contact, occlusion, reach, clearance, and travel at the start, during action, and at the end. A negative prompt is not anatomical verification.
- Trace attachment endpoints and paths through occlusion. Inspect cables, handles, rims, hinges, supports, and separate silhouettes where their physical relationship matters.
- For a fixed camera, lock set geometry, static prop coordinates, registration anchors, depth ordering, and lighting. Define directional features in both character and camera coordinates.
- Preserve causal acquisition and release: empty, retrieved, carried, loaded, and output states must occur in a plausible order. Do not preload a prop before the action that obtains it.
- Allocate source duration to connected useful actions and edit handles. A clip's duration is not evidence that it contains the needed beat.
- Build only reference views required by planned shots. Independent attractive views do not establish a physically continuous environment or support an arbitrary camera orbit.
- Compare adjacent shots and actual motion transitions, not just isolated endpoints. Exact-source surfaces must retain identity and plausible support through the action.

## Required response

Reject a physically impossible or contradictory state from verified status even when aesthetically attractive. Record the failed invariant and downstream dependencies; repair within existing authority or choose a compatible shot plan before continuing dependent generation.
