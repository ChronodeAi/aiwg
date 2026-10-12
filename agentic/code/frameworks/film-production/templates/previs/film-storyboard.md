---
name: film-storyboard
description: Timed storyboard panels and animatic bound to the coverage lock
---

# Film Storyboard

Source: story proof / shot plan version: | Controlling references (ids, versions, hashes): | Timeline fps:

| panel | shot | event_ids | tl_in | tl_out | camera | framing | action | prop_states | hands | speech_mode | mouth_visible | cue | source_route | image | image_sha256 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

- One panel per event group. `event_ids` lists the shot-plan event IDs the panel shows; every required event appears in some panel.
- `tl_in` and `tl_out` are integer timeline frames; `tl_out` is exclusive, so a panel lasts `tl_out - tl_in` frames and panels do not overlap.
- `prop_states` records count, location and open/closed state; `hands` records each hand's occupancy and contact.
- `speech_mode` is `internal`, `visible`, `offscreen`, `narration` or `none`; `mouth_visible` is `yes` or `no`; `cue` names the dialogue cue ID mirrored into current state `dialogue_cues`.
- `source_route` is `generate`, `reference-footage`, `3d-blocking` or `exact-layer`.
- `image` is the panel frame path, drawn only from controlling character/set references, 3D blocking renders or existing frames. Write `MISSING` (and leave `image_sha256` empty) for a required event with no frame; a `MISSING` panel is an open coverage gap, not an accepted elision.

## Animatic

Audio (one line per source, `path@tl_frame`, locked takes only):
Duration (frames, seconds):
Animatic path / sha256:
Real-speed watch evidence (reviewer, date, what was checked: skipped causal beats, teleports, unmotivated cuts):
Coverage lock subject_sha256 (must equal the animatic sha256):
