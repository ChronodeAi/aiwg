---
name: film-performance-sound
namespace: aiwg
platforms: [all]
description: Direct film dialogue and contextual sound while preserving selected performances and speech modes.
triggers:
  - "film-performance-sound"
  - "direct film performance and sound"
commandHint:
  modelRole: efficiency
  modelTier: economy
---

# Film Performance and Sound

## Inputs

Read the story proof, current dialogue, selected voice takes, shot records, timing, and sound intent. Load `aiwg show template film-voice-cue-sheet`.

## Workflow

1. Version the line list and mark every cue as internal thought, visible speech, off-screen speech, narration, or nonverbal action. Preserve selected wording, voices, and performances; record a dialogue diff when an authorized revision changes them.
2. Establish performance intent in context: listener, subtext, pace, energy, pauses, and the action the line motivates. Audition a representative exchange before investing in dependent picture work. Discover the relevant adapter and honor existing voice-use and generation authority.
3. Keep original takes immutable and track edits separately. Visible speech needs the selected audio aligned to visible delivery; internal thought must leave lips still unless the story explicitly calls for another visible action.
4. Match processing to intent through dry-versus-processed contextual audition. Perceived distance can use level, tone, and space; repeated echoes are not a default substitute. Keep approved effects unless the requested change affects them.
5. Build sound from observed physical phases. For a machine, align mechanisms, motor, scan, rollers, and output only where those actions occur. Avoid generic clicks that imply nonexistent contact or motion. Match each planned contact event with one sound; never duplicate a press across a cut.
6. Use no constant bed, room tone, or hum except explicitly approved ones. Before placing any foley or effect clip, solo it and check its noise floor, hiss, hum, and tail; clean it with noise reduction, EQ, or a gate/trim, or reject it. Re-check after level matching, since gain raises the floor.
7. Listen against the real edit, including transitions and quiet moments. Check intelligibility, abrupt level changes, clipping, sync, background noise introduced at clip edges, unwanted artifacts, and whether music or effects obscure the story. Inspect the exported audio as well as the working timeline.

## Outputs

Produce the cue sheet, versioned takes, editable processing/mix, contextual audition evidence, and remaining issues. Record each placed clip in current state `audio_elements` with measured noise floor (and spectral flatness where the project sets a limit), the measuring tool, and bed approval; record `locks.sound` after picture lock when FP-G05b criteria pass.

## Continue or hold

Continue when performance supports the intended causal beat and speech mode. Hold mismatched delivery or sync from final acceptance. A voice selection does not approve every generated take, and a technically clean waveform does not prove the performance works.
