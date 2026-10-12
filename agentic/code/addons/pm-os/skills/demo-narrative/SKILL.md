---
name: demo-narrative
description: >-
  Use when a PM needs a *story-driven* demo script for a prototype or feature — a named protagonist, a scenario with stakes, and a beat-by-beat walkthrough — instead of a feature tour. Fires on "script my demo," "make this demo land," or prep for showing a prototype to stakeholders. Not for the deck around the demo (`presentation-narrative`, `5-step-story-deck`) or for reading the room politically (`prep-the-room`).
---

# Script a story-driven demo

## Step 1 — Get the four facts

Ask, in one question, for: what's being demoed and which parts actually work; who the audience is; how long the slot is; and what the demo should produce — a decision, budget, feedback, adoption. The last one is the demo's job; everything in the script serves it.

Done when all four are answered. If the "what works" answer is vague, list the screens or flows that are live before writing anything.

## Step 2 — Build the protagonist and the scene

Name a specific person with a role the audience recognizes, grounded in real research if any exists — say which interview or finding, or flag the persona as assumed. Then set the scene: the trigger event that makes them open the product, the deadline, and the cost of failing. Concrete numbers and dates ("Thursday 3pm, forecast due tomorrow morning, the old way takes 4 hours") beat adjectives.

Done when the protagonist has a name and role, the trigger and stakes are stated in one paragraph, and the audience would recognize the situation as one of theirs.

## Step 3 — Script the beats

Walk the protagonist through the task as numbered beats. Each beat: what they do (the exact click or input), what appears on screen, and what they think or say. Use only screens that work — verified against the Step 1 list. Include exactly one hesitation or wrong turn with recovery; a flawless run reads as staged, more than one reads as broken.

Done when every action in the script maps to a working screen and the beats run trigger to finished task with one recovery moment.

## Step 4 — Mark the aha and the outcome

Mark the single beat where the value becomes obvious — the aha — and slow the script there: what to say, where to pause. Then close with the outcome against the old way, as a number: time saved, steps removed, error rate cut. If no honest number exists, say what would have to be measured to get one — don't invent it.

Done when the aha is one specific beat and the closing outcome is a number or an explicitly named unknown.

## Step 5 — Fit the slot and add the fallback

Cut the script to the time slot: executives get the outcome first and compressed beats; end users get the full flow; engineers get the integration points called out. Then add the fallback — screenshots or a recording of the key beats in order, ready before the meeting.

Done when the script read aloud at conversational pace fits the slot with 20% left for questions, and the fallback assets are listed.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-demo-narrative-{feature-slug}.md`. Never hand-build the path.

The doc holds: the four facts, the protagonist and scene, the numbered beats, the aha beat and closing number, the time-fitted script, the fallback list.
