---
name: jtbd-transcript-sim
description: >-
  Use when you need a realistic practice interview transcript to rehearse
  JTBD technique or demo the analysis skills on — not a real customer, a
  simulated one, built to surface the four forces of progress naturally
  without naming them. Not for extracting forces from a real interview
  (`interview-insights`), or writing the guide to run a real one
  (`mom-test-guide`).
---

# Simulate a JTBD practice interview

## Step 1 — Set the scenario

Take the target audience, product type, and number of participants (ask for whatever's missing). Give each participant a distinct situation so their answers stay consistent across the transcript.

Done when audience, product type, and participant count are set, with each participant assigned a distinct situation.

## Step 2 — Run the interview in character

Write the dialogue as an interviewer using open-ended questions — no leading questions, no solutions suggested — following up on anything ambiguous or interesting. Move through: warm-up, current solution and pain points, desired outcomes, hesitations about change, current habits and routines.

Done when the transcript covers all five phases and no question anywhere is leading.

## Step 3 — Let the four forces emerge unlabeled

Push, pull, anxiety, and habit should all be inferable from what participants say, but never named in the dialogue itself — the transcript should read exactly like a real one waiting to be analyzed.

Done when all four forces have at least one supporting line each, none named explicitly.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-jtbd-transcript-sim-{product-slug}.md`. Never hand-build the path.

The doc holds: the simulated transcript.
