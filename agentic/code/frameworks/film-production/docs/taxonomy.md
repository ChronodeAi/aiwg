# Film-production taxonomy

This is the framework's proposed operating taxonomy, informed by the primary
sources in [sources.md](sources.md) and production failure analysis. The IDs,
acceptance gates, repair limits, and approval dimensions are framework practices,
not external standards. Interchange formats and provider guidance have narrower
purposes; none guarantees generated continuity or creative acceptance.

## Lifecycle and capabilities

| ID | Phase | Skill | Responsibility and output |
|---|---|---|---|
| FP-C01 | Develop | `film-intake` | Establish intent, audience, format, constraints, scope, existing authority, and delivery requirements in a production brief. |
| FP-C02 | Develop | `film-story-proof` | Prove premise, character knowledge, causality, dialogue, and performance timing with a script, read-through, or animatic. |
| FP-C03 | Design | `film-continuity-pack` | Define required character, anatomy, costume, set, prop, lighting, and spatial references, with controlling versions. |
| FP-C04 | Previs | `film-shot-plan` | Break scenes into shots, action phases, sound requirements, start/end states, coverage, and usable edit handles. |
| FP-C05 | Generate | `film-provider-preflight` | Verify the selected provider/model's supported controls, input requirements, current authority, bounded cost, and recovery path. |
| FP-C06 | Design / Generate | `film-reference-edit` | Choose reference roles and localized or native-layer edits; retain exact sources and check changed regions plus invariants. |
| FP-C07 | Generate | `film-motion-coverage` | Produce and inspect connected action, physical interactions, camera behavior, and sufficient coverage for the intended cut. |
| FP-C08 | Develop / Finish | `film-performance-sound` | Select voice performances and speech modes; align dialogue, ambience, foley, effects, and music with picture. |
| FP-C09 | Finish | `film-edit-conform` | Assemble accepted versions, preserve selected dialogue/takes, finish composites/color/sound, and verify the current timeline. |
| FP-C10 | All | `film-review-gate` | Judge named acceptance dimensions against exact versions using inspected evidence and explicit residual defects. |
| FP-C11 | Deliver | `film-delivery` | Check exports against delivery requirements; package masters, derivatives, captions, editable sources, and provenance as scoped. |
| FP-C12 | All | `film-retrospective` | Measure accepted outcomes, escaped defects, attempts, actual cost, and time; propose bounded improvements. |

Capabilities may be revisited without restarting unaffected work. A representative
shot should establish a viable method before dependent batches. Build only the
reference views the planned shots require; independent pictures do not establish
a coherent three-dimensional environment.

## Entity and asset identity

Use stable entity IDs with separately versioned artifacts. Suggested namespaces:

| Entity | Suggested ID | Meaning |
|---|---|---|
| Project, sequence, scene, shot, take | `FP-PROJ-*`, `FP-SEQ-*`, `FP-SCN-*`, `FP-SHOT-*`, `FP-TAKE-*` | Narrative and production hierarchy, distinct from file paths. |
| Character, set, prop, sound cue | `FP-CHAR-*`, `FP-SET-*`, `FP-PROP-*`, `FP-CUE-*` | Persistent identities whose states can vary across shots. |
| Asset, generation run, approval, defect, delivery | `FP-ASSET-*`, `FP-RUN-*`, `FP-APPROVAL-*`, `FP-DEFECT-*`, `FP-DELIVERY-*` | Media/evidence records with version, lineage, and status. |

Keep existing research `REF-*` and media acquisition IDs as external references.
Do not create competing copies of their authoritative records.

Classify every asset on two independent axes:

- **Origin:** captured, generated, authored in a digital-content tool, composited,
  or derived.
- **Role:** aesthetic master, character/anatomy master, environment master,
  blocking guide, exact artwork/screen source, performance master, or candidate.

A generated screen image is not an authentic screenshot. A degraded blocking
guide is not a quality master. Exact-source art may undergo documented cropping,
perspective, tracking, and color treatment; keep the original and transformation
lineage, and do not call transformed output byte-identical. Distinguish fictional
character knowledge from source provenance and audience knowledge.

## Current-state contract

The current-state record points to controlling references, asset versions/hashes,
shot start/action/end states, dialogue and audio versions, selected takes,
unresolved defects, dependencies, approvals, provider task IDs, and the next
permitted action. Detailed artifacts may remain separate; the current record
must resolve them unambiguously.

Record object counts, hand occupancy, contact/support, attachment endpoints,
clearance, screen direction, and physical scale where material to the shot.
Separate production status from acceptance: a paused project can retain accepted
assets, while an active project can contain blocked shots.

Approvals name the exact version, dimension, scope, reviewer, and evidence.
Dimensions include story, blocking, visual quality, performance, motion,
editorial, and delivery. Changed inputs invalidate affected dimensions and
downstream dependencies, while unaffected approvals remain usable. Historical
directions cannot silently override the current state.

## Acceptance gates

| ID | Gate | Minimum evidence |
|---|---|---|
| FP-G00 | Scope ready | Current brief, delivery requirements, relevant constraints, existing authority, and unresolved decisions identified. |
| FP-G01 | Story ready | Required beats and lines present; character knowledge and action consequences coherent; timing demonstrated. |
| FP-G02 | Source ready | Controlling reference roles/versions identified; usable source quality; exact-source layers retained; material defects resolved. |
| FP-G03 | Shot ready | Physical action states and edit coverage viable; provider capability checked; run within current authority. |
| FP-G04 | Take accepted | Actual playback inspected; target change and invariants checked; contact transitions and sound/performance checked where relevant. |
| FP-G05 | Edit accepted | Adjacent shots and full timeline reviewed; selected versions, dialogue, continuity, color, and mix verified. |
| FP-G06 | Delivery accepted | Exported files checked against specifications; agreed package complete; residuals, provenance, and archive references recorded. |

Gates are evidence checks, not mandatory new permission requests. Existing user
authority persists. Missing authority, a material creative decision, or a genuine
dependency can require input; a routine reversible correction need not.

An attractive image can fail a gate. Inspect native-size detail and the full
frame, and review motion in playback rather than certifying it from stills.
After two failed attempts at the same defect with the same method, diagnose and
change the permitted method or report the blocker. Reconcile an ambiguous paid
task using its known identifier before considering another submission.

Record a seed only when the provider supplies or supports it. Never infer exact
reproduction from a seed, hash, prompt, or receipt. Measure first-pass acceptance,
user-found escaped defects, attempts per accepted shot, actual cost, and elapsed
work; activity counts alone do not demonstrate improvement.
