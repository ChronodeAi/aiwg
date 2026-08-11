---
name: strategic-deck
description: >-
  Use when you need to plan a presentation for a specific audience and time slot before building any slides — decide the depth, tone, data-vs-narrative balance, and the SCQA spine the deck will hang on. Not for writing the narrative prose (`presentation-narrative`), structuring slides from a problem (`problem-deck`), or reading the room politically (`prep-the-room`).
---

# Brief the deck before you build it

## Step 1 — Get topic, audience, time

Ask in one question for: the topic, who's in the room, and how long the slot is. These three set every downstream choice.

Done when all three are stated. If the audience is "leadership" or "the team," push for who specifically and what they can decide.

## Step 2 — Read the audience into constraints

For the named audience, fix four dials: technical depth, how much evidence they need before they trust a claim, tone, and where they'll need extra context you'd otherwise skip. Base each on what this audience actually rewards, not a generic exec persona.

Done when each of the four dials has a value tied to a specific fact about this audience.

## Step 3 — State the purpose and the win

Name the one thing the deck exists to get: a decision, a green-light, alignment, or funding. Write the success line — what the room does next if it lands — and the metric you'd point to afterward.

Done when the purpose is one of {decision, inform, persuade}, the success line is one sentence, and it names a concrete next action.

## Step 4 — Set the SCQA spine

Compress the whole argument into four lines: Situation the room already agrees with, Complication that makes the status quo untenable, Question that forces, Answer that is your recommendation. If any line is soft, the deck will wander.

Done when all four lines are written and the Answer is a specific recommendation, not a topic.

## Step 5 — Decide the deck shape and hand off

From the time slot and dials, set: slide count, the data-vs-narrative balance, and which supporting materials (appendix, pre-read, backup analysis) you'll need. Name where the build goes next — the narrative or the slide storyline.

Done when slide count, balance, and materials are fixed, and the next build step is named.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-strategic-deck-{topic-slug}.md`. Never hand-build the path.

The brief holds: topic/audience/time, the four dials, purpose and success line, the SCQA spine, and the deck-shape decision.
