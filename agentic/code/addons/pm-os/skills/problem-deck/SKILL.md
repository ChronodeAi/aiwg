---
name: problem-deck
description: >-
  Use when you need to turn a problem and a recommendation into a slide-by-slide storyline — question-title slides where each answers the one before, building to the ask (Minto/Pyramid + What/So What/Now What). Not for arranging content you already have (`what-so-what-deck`), writing the narrative prose (`presentation-narrative`), or planning depth and tone for an audience (`strategic-deck`).
---

# Build the slide storyline from a problem

## Step 1 — Get the problem and the recommendation

Ask for the problem statement, the context around it, and where you're landing — the recommendation. Without a destination the storyline can't chain.

Done when the problem and the intended recommendation are both stated.

## Step 2 — Set the governing thought

Write the one-line answer the whole deck defends — the top of the pyramid. Every slide below exists to support it.

Done when the governing thought is a single declarative sentence, not a topic.

## Step 3 — Build the question chain

Title each slide as a question, ordered so each slide's answer raises the next slide's question, running What → So What → Now What toward the recommendation.

Done when the titles read in sequence as a self-propelling Q→A chain that ends on the ask.

## Step 4 — Fill and lay out each slide

For each slide give: the answer as key points, the layout (what element sits where on the canvas), and any chart or visual. Stay data-driven; don't invent numbers the inputs don't support.

Done when every slide has key points, explicit layout guidance, and named visuals where they help.

## Step 5 — Bookend and hand off

Open with an executive-summary slide and close with conclusion + next steps. Aim for 8–12 slides depending on complexity. Then hand the outline to the build step.

Done when the deck is bookended, sits at 8–12 slides, and the next build step is named.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-problem-deck-{topic-slug}.md`. Never hand-build the path.

The outline holds: the governing thought, the question-titled slide chain, per-slide key points and layout, and the exec-summary/next-steps bookends.

**Build the deck:** hand this outline to the `frontend-slides` skill to produce a styled, single-file HTML presentation.
