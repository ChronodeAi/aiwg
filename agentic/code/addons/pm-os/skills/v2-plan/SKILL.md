---
name: v2-plan
description: >-
  Use when a product has launched, feedback has piled up, and the PM needs a prioritized v2 plan — *themes* scored with one framework and sequenced into phases. Fires on "what should v2 be?" or "turn this feedback into a roadmap." Not for planning how to collect post-launch feedback (`feedback-loop`), answering research questions (`research-synthesis`), or support tickets alone (`tickets-to-improvements`).
---

# Turn post-launch feedback into a v2 plan

## Step 1 — Inventory the feedback and name the v2 goal

Ask for: every feedback source with rough volume (analytics, tickets, interviews, reviews, sales notes, internal), and the one-sentence goal v2 serves — retention, expansion, a segment, a metric. The goal is the tiebreaker for everything downstream; without it, scoring is arithmetic theater.

Done when sources are listed with volumes and the v2 goal is one sentence the user has confirmed.

## Step 2 — Cluster into themes

Group the feedback into themes — usability, missing capability, performance, onboarding, whatever the data actually says. For each theme: how many mentions across which sources, who's affected, severity, and one verbatim quote that captures it. A theme sourced from one channel only gets flagged — it may be that channel's bias, not the product's problem.

Done when every theme has counts, sources, severity, and a quote, and single-source themes are flagged.

## Step 3 — Score with one framework

Pick one scoring framework — default RICE (Reach × Impact × Confidence ÷ Effort) unless the team already uses another — and score every theme with it. One framework, applied consistently, beats four applied loosely. Confidence must reflect Step 2's evidence: a single-source theme cannot score high confidence.

Done when every theme has a score with its inputs shown, and the ranking makes the top themes visibly separate from the tail.

## Step 4 — Turn the top themes into improvements

For each top theme: a problem statement (what's wrong, for whom), the proposed change, and a success criterion as metric-from-baseline-to-target. If no baseline exists, name the measurement to run before building. Keep it at the problem level — user stories and specs belong to `/prd`.

Done when every improvement has a checkable success criterion or a named baseline measurement.

## Step 5 — Sequence into phases

Three phases: **fix now** (broken, blocking, or bleeding users — regardless of score), **next** (highest scores serving the v2 goal), **later** (deferred, each with its reason). Everything from Step 2 lands somewhere — a theme silently dropped will return as a stakeholder ambush.

Done when every theme is in a phase or explicitly cut with a reason, and fix-now contains only things that are actually broken.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-v2-plan-{product-slug}.md`. Never hand-build the path.

The doc holds: the source inventory and v2 goal, the theme table with evidence, the scored ranking, the improvements with success criteria, the three phases.
