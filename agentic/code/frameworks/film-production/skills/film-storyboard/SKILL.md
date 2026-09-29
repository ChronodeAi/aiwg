---
name: film-storyboard
namespace: aiwg
platforms: [all]
description: Build a timed storyboard and animatic from controlling references, marking each dialogue cue's mouth visibility and source route, before the coverage lock.
triggers:
  - "film-storyboard"
  - "storyboard the film"
commandHint:
  modelRole: efficiency
  modelTier: economy
---

# Film Storyboard

## Inputs

Use current state, the story proof, shot records with their event lists, the continuity bible's controlling character and set references, selected audio takes, and the timeline fps. Load `aiwg show template film-storyboard`.

## Workflow

1. Read the story proof and every shot-plan event list. List the required events in story order; each must reach a panel or be marked missing.
2. Make one panel per event group from controlling character/set references, 3D blocking renders or existing frames — never new designs. Record each panel's shot, event IDs, integer timeline in/out frames (out exclusive), camera, framing, action, prop states, hand occupancy, source route and image hash.
3. Mark every dialogue cue's speech mode, whether the speaker's mouth is on screen, and its route. Mirror each cue into current state `dialogue_cues` with its mouth-visible frame ranges and sync method; visible speech with the mouth on screen needs an audio-driven or lip-sync path, and internal, off-screen and narration cues never use lip sync.
4. Mark required events with no picture `MISSING`. A missing panel is an open coverage gap, not an elision; eliding a required beat stays a scope change needing authority.
5. Assemble a timed animatic with locked audio: each panel held for exactly its frame count, audio placed at its recorded timeline frame. Record the animatic path, duration and sha256.
6. Watch at real speed; flag skipped causal beats, teleports and unmotivated cuts. Stills and frame-stepping do not replace the real-speed watch.
7. Hand the animatic hash to the coverage lock: record `storyboard {path, sha256, panel_count, animatic_path, animatic_sha256}` in current state and lock coverage with `subject_sha256` equal to the animatic sha256.

## Outputs

A storyboard record with panel table, animatic section and hashes; the animatic file; `storyboard` and `dialogue_cues` in current state; a list of `MISSING` events and flagged continuity breaks.

## Continue or hold

Continue to the coverage lock when every required event has a panel, every dialogue cue has a route, and the real-speed watch found no unresolved causal break. Hold on `MISSING` required events or an unwatched animatic. Any storyboard or animatic change makes the coverage lock stale: rebuild the animatic and relock before paid motion.
