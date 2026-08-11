---
name: brainstorm-genius
description: >-
  Use when the user wants an ideation session on any topic where the point is to beat the *banal bar* — the obvious ideas anyone would produce — through breadth techniques: association, inversion, adjacent-field transplants. Fires on "brainstorm X with me," "I need non-obvious ideas about Y." Not for product-idea sessions (`product-brainstorm`), constraint-driven ideation (`constrained-ideas`), question generation (`good-question-brainstormer`), or problem reframing (`lateral-thinking`).
---

# Run an ideation session that beats the obvious

## Step 1 — Pin the topic and the purpose

Get the topic and what the ideas are *for* — a decision to make, a backlog to feed, a talk to write. Purpose sets the filter for Step 5; ideas for a decision get judged differently than ideas for inspiration. Note any hard exclusions.

Done when topic and purpose are each one sentence.

## Step 2 — Set the banal bar

Write the 5–8 ideas anyone would produce: the first search-result answers, the conference-talk clichés, the currently overhyped defaults. These aren't discarded — they're the bar. Some may even be right, but they don't need a session to find.

Done when the list is written and each entry has one line on why it's the default.

## Step 3 — Generate wide from three angles

Produce raw ideas from three distinct directions, at least four ideas each:

- **Association** — break the topic into its components and chain outward from each; follow chains two or three hops past the first stop, where the non-obvious lives.
- **Inversion** — ask how to guarantee failure at the goal, then invert each answer into an idea.
- **Transplant** — find how a distant field solves the analogous problem (logistics, medicine, games, religion) and carry the mechanism over.

An idea matching the banal bar gets cut on sight.

Done when there are 12+ raw ideas, each tagged with its angle, and none matches a bar entry.

## Step 4 — Develop the strongest candidates

Pick the 3–5 with the most pull and push each through at least one transformation — combine two, exaggerate to the extreme and walk back, shrink to the smallest complete version, swap who it's for. Keep whichever variant is strongest against the Step 1 purpose.

Done when each candidate has a surviving variant and one line on what the transformation changed.

## Step 5 — Deliver the top three with a first test

Present the top 3 ideas. Each gets: why it beats the banal bar (what it sees that the defaults don't), and the first cheap test — the smallest action that generates evidence the idea deserves to live. Ideas without a conceivable test go back to Step 4 or out.

Done when each of the three names its edge over the bar and a test someone could run within a week.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-brainstorm-{topic-slug}.md`. Never hand-build the path.

The doc holds: the topic and purpose, the banal bar, the raw ideas by angle, the developed candidates, the top three with edges and first tests.
