---
name: product-strategy
description: >-
  Use when product context needs shaping into a structured strategy document through the seven-part template — Objective, Users, *Superpowers*, Vision, Pillars, Impact, Roadmap — where each section must build on the previous ones. Also /strategy Step 1b, taking the crux and competitor analysis as input. Not for diagnosing the strategy problem itself (`strategy-kernel`), backcasting from an end state (`limit-strategy`), or the full strategy workflow (`/strategy`).
---

# Draft a structured product strategy

## Step 1 — Gather the context

Get the product context: what the product is, its market, and what's already known. Inside `/strategy`, that's the crux and the competitor map; standalone, ask for the product description and the problem the strategy must answer.

Done when the context names the product, the market, and the question the strategy answers.

## Step 2 — Write the Objective and the Users

**Objective**: 1–2 sentences stating the change in the world this product exists to make — ambitious enough to matter, concrete enough to check progress against. **Users**: 1–2 key groups, each with a one-line identity and 3–4 needs in their words. More than two groups means the strategy hasn't chosen yet — force the cut or flag it as the open question.

Done when the objective is checkable, and each user group has an identity line and its needs.

## Step 3 — Name the Superpowers

List 3–4 things this product or team can do that competitors genuinely can't — an asset, a position, a capability, a distribution channel. The test for each: would a competitor PM reading it wince, or shrug? "Great team" and "user-focused" shrug. If fewer than three survive the test, say so — that finding is worth more than a padded list.

Done when each superpower passes the wince test or the shortfall is stated as a finding.

## Step 4 — Write the Vision

2–3 paragraphs of what the world looks like if this succeeds — built specifically from the Users and Superpowers, not generic category prose. The check: strike out the product name; if any competitor could paste theirs in, the vision isn't yours yet.

Done when the vision survives the name-swap check and visibly draws on Steps 2–3.

## Step 5 — Choose the Pillars and trace the Impact

**Pillars**: 2–4 work themes that follow from the Vision, Users, and Superpowers, each with a title and a short description of what it covers and excludes. **Impact**: for each pillar, the mechanism from work to objective — "solving X increases Y which drives Z" — or a back-of-envelope number. A pillar with no traceable mechanism is a department, not a pillar.

Done when every pillar has a stated mechanism or number connecting it to the objective.

## Step 6 — Sketch the Roadmap

Under each pillar, list 3–10 obvious things to build. Unprioritized on purpose — this is the strategy's evidence that the pillars generate real work, not the delivery plan. Prioritization belongs to later steps (`p0-p1-p2`, `/strategy` Step 2 onward).

Done when every pillar has at least three concrete items and none is a restated pillar title.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-product-strategy-{product-slug}.md`. Never hand-build the path.

The doc holds the seven sections in order: Objective, Users, Superpowers, Vision, Pillars, Impact, Roadmap — plus any open questions flagged along the way.
