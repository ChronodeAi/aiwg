---
name: what-so-what-deck
description: >-
  Use when you already have the content — findings, data, notes — and need to arrange it into a presentable flow, surfacing which of What / So What / Now What is missing. Not for deriving a storyline from a problem (`problem-deck`), writing narrative prose (`presentation-narrative`), or planning depth and tone for an audience (`strategic-deck`).
---

# Arrange content you already have

## Step 1 — Take the content dump

Collect everything you mean to present — findings, charts, notes, raw points. Don't add or invent; work only with what's there.

Done when the full set of content is in front of you and nothing is being fabricated to fill space.

## Step 2 — Sort every piece into the flow

Bucket each piece: **What** (the facts, what's true), **So What** (why it matters, the implication), **Now What** (the action it points to). One piece can seed a later bucket — note that.

Done when every piece of content lands in at least one bucket.

## Step 3 — Flag the gaps

Name which bucket is thin or empty — usually So What (implications left implicit) or Now What (no action). For each gap, say what would fill it, drawing only on the content or an explicit assumption.

Done when every thin bucket is named with a concrete suggestion for filling it.

## Step 4 — Order the slides

Lay the buckets into slide order: descriptive title that states the point, supporting statements beneath, top-to-bottom then left-to-right. Introduce new information so it never lands before its setup.

Done when the slides run in an order where each reads without confusion and pulls the reader forward.

## Step 5 — Lay out and hand off

For each slide give the layout and any chart the content already supports. Open with the presentation's purpose, close with the takeaways. Then hand the outline to the build step.

Done when every slide has layout and named visuals, the deck is bookended, and the next build step is named.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-what-so-what-deck-{topic-slug}.md`. Never hand-build the path.

The outline holds: the sorted What/So What/Now What buckets, the flagged gaps and fills, the ordered slides with layout and visuals, and the purpose/takeaway bookends.

**Build the deck:** hand this outline to the `frontend-slides` skill to produce a styled, single-file HTML presentation.
