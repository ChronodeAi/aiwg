---
name: film-edit-conform
namespace: aiwg
platforms: [all]
description: Assemble verified film assets into an editable timeline and verify actual playback and export ranges.
triggers:
  - "film-edit-conform"
  - "conform film edit"
commandHint:
  modelRole: efficiency
  modelTier: economy
---

# Film Edit Conform

## Inputs

Read current state, ordered shot records, accepted source ranges, dialogue/cue sheet, exact-source layers, and delivery settings. Load `aiwg show template film-review-record`.

## Workflow

1. Discover the available editor adapter and verify the actual loaded project, timeline, media, frame rate, and working range. A running editor or successful connection is insufficient evidence of the correct project.
2. Reuse one current review timeline with versioned assets. Before each structural edit, take a backup snapshot, preferring the editor's native timeline backup/compare feature over manual project exports. Do not create a new production branch for every small correction.
3. Conform the causal shot order, accepted source ranges, edit handles, and approved dialogue. Diff the line list to catch accidental omissions. Keep exact art/screen composites, titles, audio takes, and processing editable in the timeline.
4. Place sound against observed action phases and maintain the recorded speech modes. Track overlays and exact art with the editor's native tracker; inspect perspective, occlusion, containment order, and support over the whole clip rather than trusting endpoint alignment. Retime with the editor's speed/retime controls and review the result in playback.
5. Inspect all source ranges, transitions, speed changes, trims, and total runtime. Check for gaps, unintended repeats, frozen tails, missing media, frame-rate mistakes, and premature out-points. Investigate source detail before attributing visible degradation to export bitrate.
6. Play the full timeline with audio at intended viewing scale. Play every cut at speed with at least one second of context either side and frame-step the join against the shot records' cut entry/exit states. Frame-step critical contact and sync transitions, then export the actual required range and inspect playback of that exported file.
7. Record project/timeline identity, source versions, export settings, observed results, and unresolved defects. Keep known failures on hold in current state.

## Outputs

Deliver the editable project/timeline, a current review export, and a review record linked to exact versions. In current state, record `timeline` (with the review export hash) and one `cuts` entry per adjacent shot pair with its playback review; record `locks.picture` when FP-G05a criteria in `docs/taxonomy.md` pass, and run the state validator.

## Continue or hold

Continue to delivery review when playback and export checks pass. Hold a render with unplayed sections or known defects from verified status. A successful export job proves file production, not narrative, audiovisual, or delivery acceptance.
