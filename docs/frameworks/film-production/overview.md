# film-production Overview

film-production is a provider-neutral framework for reference-driven films, animated shorts, and episodic content. It
turns story intent, immutable references, and physical shot states into reviewable media and a verified delivery. It
does not generate media by itself, install editors or generation services, or grant spend or publication authority.

## Common Use Cases

- Turn a premise into a production brief, story proof, and dialogue lock before any shot is generated.
- Build a continuity pack of controlling character, prop, set, and art references with hashes and counts.
- Plan shots with per-shot event lists, cut entry/exit states, and coverage before paying for motion generation.
- Review generated takes in playback against the requested fix and the scene's invariants.
- Assemble, conform, and mix accepted takes in DaVinci Resolve or Mirage Tesseract, then check the exported file.
- Revise a locked production and trace which shots, cuts, and locks the change invalidates.

## Lifecycle

Work moves through six phases: **develop → design → previs → generate → finish → deliver**. Capabilities can be
revisited without restarting unaffected work.

| Phase | Skills | Output |
|-------|--------|--------|
| Develop | `film-intake`, `film-story-proof`, `film-performance-sound` | Production brief, story proof, dialogue and selected takes |
| Design | `film-continuity-pack`, `film-shot-plan`, `film-reference-edit` | Continuity bible, shot records, controlling references |
| Previs | `film-reference-edit`, `film-performance-sound` | Animatic watched at real speed, voice cue sheet, coverage lock |
| Generate | `film-provider-preflight`, `film-reference-edit`, `film-motion-coverage` | Generation receipts, accepted takes with recorded event walks |
| Finish | `film-edit-conform`, `film-performance-sound` | Current timeline, picture lock, measured audio, sound lock |
| Deliver | `film-delivery` | Checked exports, masters, derivatives, captions, editable sources, provenance |
| All | `film-review-gate`, `film-retrospective` | Review records, escaped defects, measured outcomes |

## Acceptance Gates and Locks

Locks are recorded in the production state file (schema v2) and are the single source of gate criteria.

| ID | Lock | Blocks |
|----|------|--------|
| FP-G03 | Coverage lock | All paid motion generation |
| FP-G05a | Picture lock | Sound lock |
| FP-G05b | Sound lock | Delivery |
| FP-G06 | Delivery accepted | Calling a version final; publication stays separately authorized |

Picture lock requires an accepted playback review of every cut at the current timeline hash — stills never pass.
Coverage lock is the only lock that may be waived, and only with a recorded reason and authority. A defect the user
finds that review missed is added to the review checklist, which re-checks already passed work for that class.

The state checker `scripts/validate-film-state.mjs` verifies these recorded constraints:

```bash
node scripts/validate-film-state.mjs <state.json>   # run from the framework directory
```

It checks recorded evidence only. It cannot inspect images, play media, authenticate a reviewer, or prove creative
quality.

## Core Components

The framework ships one kernel skill, `film-production-quickref`, which routes to 12 operational skills, 6 agents,
7 rules, 8 lifecycle and revision flows, and 8 templates.

### Agents

| Agent | Purpose |
|-------|---------|
| `film-producer` | Coordinate bounded production from current state through verified delivery |
| `film-story-director` | Develop causal story and performance proof before dependent production |
| `film-scene-supervisor` | Plan and verify reference-driven scene construction, localized repair, and motion inputs |
| `film-continuity-supervisor` | Verify character, prop, set, performance, and editorial continuity against controlling versions |
| `film-editor-sound-supervisor` | Assemble accepted takes and verify dialogue, sound, color, and timeline conform |
| `film-qc-reviewer` | Independently review exact versions and report acceptance evidence and residual defects |

### Rules

| Rule | Purpose |
|------|---------|
| `film-state-authority` | One versioned production truth; acceptance evidence is separate from permission to act |
| `film-source-fidelity` | Preserve immutable masters and authentic source pixels across derivatives and edits |
| `film-continuity` | Preserve identity, object states, geometry, and causal transitions across shots |
| `film-performance` | Preserve dialogue intent and selected takes; match speech mode, action, and sound |
| `film-regression-review` | Inspect the target change and scene invariants before promoting a candidate |
| `film-generation-spend` | Bound generation by verified capability, existing authority, task reconciliation, and actual cost |
| `film-delivery-boundary` | Deliver verified files and editable handoffs without implying publication |

### Flows

`develop`, `design`, `previs`, `generate`, `finish`, and `deliver` cover the lifecycle; `film-resume` restarts from
current state and `film-revise-with-impact` traces a change through affected shots and locks.

## Editor Routing

The quickref keeps the existing native project as the source of truth:

| Need | Route |
|------|-------|
| Resolve timeline, conform, Fusion, Color, Fairlight, or Resolve delivery | DaVinci Resolve through verified Resolve MCP tools or an installed scripting adapter |
| Local footage editing and a portable editable composition | Mirage Tesseract `tesseract-video` skill with the local `tsrct` CLI |
| Editable animated titles, typography, diagrams, or overlays | Mirage Tesseract `tesseract-motion` skill with `tsrct` |

Tesseract has no official MCP server. Verify discovery, permissions, and a real render in each provider before editing;
no editable cross-editor round-trip is assumed.

## Relationship to Other Frameworks

film-production reuses existing framework records through stable IDs rather than copying their responsibilities.
media-marketing-kit's `video-production` supplies briefs and specifications and receives accepted masters, derivatives,
and captions. media-curator supplies immutable source records and receives archive requirements and final asset
references. research-complete's `induct-media` supplies cited factual evidence without turning it into creative
approval. Hosted image, video, and speech generation skills remain separate adapters; `film-provider-preflight` checks
their capability, authority, and cost before use.

## References

- [Quickstart](quickstart.md) — Deploy and first steps
- [Framework README](https://github.com/jmagly/aiwg/blob/main/agentic/code/frameworks/film-production/README.md) —
  Production contract and catalog
- [Taxonomy](https://github.com/jmagly/aiwg/blob/main/agentic/code/frameworks/film-production/docs/taxonomy.md) —
  Capability IDs, entity identity, current-state contract, and the full gate table
- `@$AIWG_ROOT/agentic/code/frameworks/film-production/skills/film-production-quickref/SKILL.md` — Routing entry point
