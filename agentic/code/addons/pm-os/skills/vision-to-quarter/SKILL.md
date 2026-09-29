---
name: vision-to-quarter
description: >-
  Use when a PM or design lead holds a vision deck and needs it *bridged* to this quarter's concrete work — themes turned into operational design principles, elements sorted by what's actionable now, and vague vision words pinned down. Not for writing OKRs from a vision (`vision-to-okrs`), a roadmap from user interviews (`now-next-later`), or the strategy itself (`strategy-kernel`).
---

# Bridge a vision to this quarter's work

## Step 1 — Get the three inputs

Ask for: the vision document (or its core claims), this quarter's stated objectives, and the team's capacity in rough person-weeks. Capacity turns a wish list into a plan; without it, stop and ask.

Done when all three are in hand, with capacity as a number — even a rough one.

## Step 2 — Extract the themes and pin the vague words

Pull 3–5 strategic themes from the vision, each with the line it comes from. Then list every vague word doing load-bearing work — "seamless," "enterprise-grade," "intuitive" — and give each either a working operational definition or the one question that gets it defined ("does 'enterprise' mean SSO and audit logs, or just seat management?"). Flag contradictions ("fast and simple" next to "comprehensive and powerful") instead of harmonizing them.

Done when every theme quotes its source line, and every vague word has a definition or a named question with an owner.

## Step 3 — Turn themes into design principles

Write 4–6 principles that operationalize the themes. Each must contain a decision heuristic someone could apply without asking — "expose power gradually: new capabilities default off, opt-in from settings" — and name its anti-pattern. A principle that couldn't reject any design ("be user-centric") is a platitude; cut it.

Done when every principle contains an applicable heuristic and an anti-pattern, and none would survive as a poster slogan.

## Step 4 — Sort vision elements into buckets

Sort every vision element: **this quarter** (designable and shippable with current people), **needs foundation** (blocked on research, a component, or a technical capability — name the blocker and its owner), **multi-quarter** (phased, first phase named), or **not yet scoped**. Sum the this-quarter bucket against Step 1 capacity; if it doesn't fit, move the weakest items out rather than shrinking estimates.

Done when every element is in exactly one bucket, every blocker has an owner, and the this-quarter bucket fits capacity with margin for the unplanned.

## Step 5 — Sequence the quarter

Order the this-quarter items so foundations come before what they unlock and one early item is a visible quick win. Give each item a success criterion — a metric, a validated assumption, or a shipped artifact — and set one mid-quarter checkpoint where the plan gets rechecked against what's actually happened.

Done when each item has a success criterion, the ordering respects dependencies, and the checkpoint has a date.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-vision-to-quarter-{quarter-slug}.md`. Never hand-build the path.

The doc holds: the themes with source lines, the pinned vague words and open questions, the principles with heuristics and anti-patterns, the four buckets with blockers and owners, the sequenced quarter with success criteria and the checkpoint date.
