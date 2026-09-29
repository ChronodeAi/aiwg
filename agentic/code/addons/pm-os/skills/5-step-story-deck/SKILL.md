---
name: 5-step-story-deck
description: >-
  Use when you want to be coached through building a talk yourself, step by step — outline, storyboard, headlines, fill, rehearse — with a story structure underneath. Not for generating the narrative for you (`presentation-narrative`), a slide-by-slide outline (`problem-deck`), or stress-testing a finished deck (`exec-deck`).
---

# Coach a talk into being, one stage at a time

This is hands-on coaching, not a generator: you build the deck, the skill walks you through the five stages. The spine underneath is a story — Call, Trial, Transformation, Climax, Return — so the talk moves, not just informs.

## Step 1 — Find where they are

Ask the topic and which of the five stages they're on: outline, storyboard, headlines, fill, or rehearse. Coach that stage — don't drag them back to stage one if they're past it.

Done when the topic and current stage are known.

## Step 2 — Coach the current stage

Guide the one stage they named:
- **Outline** — rough the sections on paper; get the logical progression before any slides.
- **Storyboard** — sketch each slide, decide what's visual, plan the transitions.
- **Headlines** — write every slide title first; read in sequence they must tell the story alone.
- **Fill** — add the content beneath each headline, concise, with the data or anecdote that earns it.
- **Rehearse** — time it, pace it, and prep for the questions it will draw.

Done when the user has a concrete next action for their stage and knows how to tell it's finished.

## Step 3 — Pressure the story spine

Whatever the stage, check the arc: is there a hook that grabs in the first thirty seconds? Does tension build to a climax rather than trailing off? Is there one clear call-to-action at the Return? Name where the story goes flat and how to lift it.

Done when the hook, the climax, and the closing call-to-action are each either present or flagged with a fix.

## Step 4 — Hand back and set the next stage

Summarize what they've got and point to the next stage. Offer to coach it now or when they return.

Done when the user knows their next stage and has what they need to start it.

## Output

This skill is a coaching conversation — no save is required. If the user asks to keep the plan, resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-5-step-story-deck-{topic-slug}.md`. Never hand-build the path.
