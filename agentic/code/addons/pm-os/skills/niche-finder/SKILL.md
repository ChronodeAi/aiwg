---
name: niche-finder
description: >-
  Use when a broad target needs narrowing into specific, targetable
  beachhead niches — 10 candidates, each precise enough to state in one
  sentence combining demographic, interest, geography, and a
  distinguishing feature, not a broad category restated. Not for the
  positioning statement once a niche is chosen (`positioning`), or the
  full competitive strategy (`product-strategy`).
---

# Narrow a broad target into 10 specific beachheads

## Step 1 — Take the broad input

Get the product, audience, or category to narrow, and whatever's already known about demographics, interests, geography, or distinguishing features.

Done when the broad input and any known factors are captured.

## Step 2 — Generate 10 specific niches

Write 10 niche definitions, each combining at least two of: demographic, interest or behavior, geography, and a distinguishing feature. Reject any definition broad enough to describe the whole category rather than a slice of it.

Done when all 10 niches are stated in one sentence each, and none could be mistaken for the original broad category.

## Step 3 — Check distinctness

Compare all 10 against each other — no two should describe substantially the same slice of the market.

Done when every niche offers a genuinely different angle on the target, with no near-duplicates.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-niche-finder-{topic-slug}.md`. Never hand-build the path.

The doc holds: the 10 niche definitions, each one sentence, combining specific factors.
