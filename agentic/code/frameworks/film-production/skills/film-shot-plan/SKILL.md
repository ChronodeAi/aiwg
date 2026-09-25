---
name: film-shot-plan
namespace: aiwg
platforms: [all]
description: Convert a proven film beat sequence into causal shots with physical start, action, and end states.
triggers:
  - "film-shot-plan"
  - "plan film shots"
commandHint:
  modelRole: efficiency
  modelTier: economy
---

# Film Shot Plan

## Inputs

Use current state, story proof, continuity bible, selected audio, and delivery format. Load `aiwg show template film-shot-record` for each required shot.

## Workflow

1. Give every shot a purpose: evidence revealed, action performed, or consequence observed. Record viewpoint and what the audience and characters know before and after it. Remove coverage that only repeats information unless repetition serves the intended rhythm.
2. Specify camera framing, movement and reveal limits, source references, and the exact initial and final states. Name intermediate causal actions rather than requesting a vague gesture.
3. Track prop identity, count, location, orientation, scale, support, containment/layer order (inside, behind, or in front of occluders), and attachment endpoints through those states. Assign each hand its occupancy and action. Check reach, clearance, contact, and travel distance against the locked set geometry.
4. Write a per-shot event list: every discrete contact in order (each key or button press, touch, grab, release), every prop count, and every state change (open/close, insert/remove, appear/disappear, screen content change) with its expected approximate time. Mark identity-critical art and in-world screen text as exact-source layers that must be tracked, never model-drawn.
5. Attach dialogue or sound cues with their speech modes. Visible speech requires an appropriate approved audio-driven performance path; internal thought must not inherit a speaking-mouth motion instruction. Name any approved continuous bed; everything else is event-driven sound.
6. Allocate source duration to useful connected actions and edit handles. A five-second source should not spend its entire duration completing a trivial preparatory movement when the beat needs a subsequent action and result.
7. Mark required exact-source overlays, transitions to adjacent shots with the state each cut must carry across (pointer target, finger position, key/button state, prop art and location), acceptance checks, and generation dependencies. Choose a representative difficult shot for preflight before expanding an authorized batch.

## Outputs

Write ordered shot records with event lists, state transitions, cut entry/exit states, audio links, reference roles, duration assumptions, and acceptance criteria. Update current state with dependencies and next actions.

## Continue or hold

Continue when the sequence is causally complete and physically plausible. Hold shots whose starting conditions contradict previous shots or require missing source quality. Planning a batch does not authorize its spend; existing bounded authority remains controlling.
