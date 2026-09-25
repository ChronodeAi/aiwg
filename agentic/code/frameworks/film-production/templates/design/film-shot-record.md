---
name: film-shot-record
description: Describe causal action and reference-dependent shot coverage
---

# Film Shot Record

## Shot identity
Project / sequence / scene / shot / version / story time / story beat / character knowledge:
Input assets with IDs, hashes and roles; exact layer versions; primary approved quality master:

## Blocking and physical states
Start state → ordered action phases → end state:
For each phase: time interval, actor position, left hand, right hand, prop support, attachments, mouth/speech mode, camera/reveal limits.
Object counts / distances and reach / contact and occlusion constraints / adjacent shot entry-exit match:

## Event list
Ordered discrete events: time / actor or hand / contact target (each key, button, prop) / resulting state / expected sound:
Prop counts and state changes (open-close, insert-remove, appear-disappear, screen content) with times:
Identity-critical art and in-world screen text: exact source asset ID, tracker/transform method, occluders and layer order:
Cut entry and exit states: pointer target, finger position, key/button state, prop art and location; events that must not repeat across the cut:

## Camera and performance
Framing, lens intent, axis, movement, what background may be revealed, handles:
Selected dialogue/audio hash and timing; internal thought vs audible dialogue; foley phases, music/drop/room tone:

## Generation-specific prompt
Verified provider/model/date/capabilities. Reference mode, duration/resolution/audio settings and cost estimate.
Concise positive observable motion instruction; stable-frame references carry appearance. Negative constraints only if supported. Keep universal continuity requirements separate from model-specific syntax.

## Acceptance
Required approval dimensions / target check / invariant check / native-size crops / playback evidence:
Open defects / decision / downstream affected IDs / next permitted action:
