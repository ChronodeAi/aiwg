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
| FP-C04 | Design | `film-shot-plan` | Break scenes into shots, per-shot event lists, action phases, sound requirements, start/end and cut entry/exit states, coverage, and usable edit handles. |
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

## Acceptance gates and locks

This table is the single source of gate criteria; phase flows point here rather than restating them. Locks are recorded in current state (`locks`, schema v2) and checked by `scripts/validate-film-state.mjs`. "Validator" below means a recorded-evidence check, not media inspection.

| ID | Gate / lock | Phase exit | Minimum evidence | Checked by | Blocks |
|---|---|---|---|---|---|
| FP-G00 | Scope ready | Develop entry | Current brief, delivery requirements, constraints, existing authority, unresolved decisions; project audio limits (noise floor, spectral flatness) and any `required_user_locks` recorded. | Agent | Story work |
| FP-G01 | Story and dialogue lock | Develop | Beat list where every beat names an observable on-screen event (`beats`, `required`, `treatment`); lines and selected takes versioned and hashed; character knowledge and consequences coherent. | Agent; user only where the brief requires | Design |
| FP-G02 | Continuity baseline | Design | Every hero prop, character, exact art and screen has one controlling reference with hash and count; every required beat maps to shot events (`shots[].events`); cut entry/exit states declared. | Validator (beat → event traceability, hashes) + continuity agent | First keyframes |
| FP-G03 | Coverage lock | Previs | Animatic watched at real speed; every beat marked shown, continuous, cut or elided; eliding a required beat recorded as a scope change with authority; selected audio hashes fixed. Only this lock may be waived, with reason and authority (for example a single-shot piece). | Agent prepares; user where required | **All paid motion generation** (`requested_action: generate`) |
| FP-G04 | Take accepted (per shot) | Generate | Actual playback inspected; event walk recorded with observed count and evidence per event, counts match or an accepted exception names the event; target change and invariants checked; source resolution meets the delivery floor or is an accepted exception; foley measured. | Agent + validator | Timeline placement |
| FP-G05a | Picture lock | Finish | Timeline hash recorded; every adjacent shot pair has one cut record whose latest review is accepted **playback** with ≥ 1 s context at the current timeline hash and checklist version (stills never pass); cut shot versions current; every timeline shot accepted with its motion review at the current checklist version; every required beat event in the timeline; no open blocker/major shot or cut defect; conditions due by picture closed. Later picture changes record a `change_list` and relock. | Agent + validator; user where required | Sound lock |
| FP-G05b | Sound lock | Finish | Valid picture lock on the same timeline hash; every `audio_elements` entry measured, qc pass, noise floor and spectral flatness within project limits; continuous beds carry an approval reference; stems kept separate from picture clips; exported mix listened to in context. | Script measures + validator; user listen where the agent cannot hear | Delivery |
| FP-G06 | Delivery accepted | Deliver | Picture and sound locks valid for the current timeline; all lock conditions closed; exported file checked against specification and played, including every cut; package complete; each QC issue has severity and disposition; residuals, provenance and archive references recorded. | Validator + agent; user where required | Calling a version final; publication stays separately authorized |

A lock may be conditional: `status: locked` with `conditions`, each naming the later gate (`picture`, `sound` or `delivery`) by which it must close. A condition cannot defer a blocking criterion or a required beat.

A defect the user finds that review missed is an escaped defect: add its class to `checklist.classes` and bump `checklist.version`. Picture lock then requires every shot motion review and cut review at the new version, which re-checks already passed work for that class.

Gates are evidence checks, not mandatory new permission requests. Ask for user sign-off only where the brief records it (`required_user_locks`, `required_user_dimensions`) or no agent or machine method can evaluate the criterion. Existing user authority persists. Missing authority, a material creative decision, or a genuine dependency can require input; a routine reversible correction need not. Do not copy SDLC ceremony: no gate meetings, waiting periods, percentage scores, or large reviewer panels. The rule is zero open blockers per level.

An attractive image can fail a gate. Inspect native-size detail and the full
frame, and review motion in playback rather than certifying it from stills.
After two failed attempts at the same defect with the same method, diagnose and
change the permitted method or report the blocker. Reconcile an ambiguous paid
task using its known identifier before considering another submission.

Record a seed only when the provider supplies or supports it. Never infer exact
reproduction from a seed, hash, prompt, or receipt. Measure first-pass acceptance,
user-found escaped defects, attempts per accepted shot, actual cost, and elapsed
work; activity counts alone do not demonstrate improvement.
