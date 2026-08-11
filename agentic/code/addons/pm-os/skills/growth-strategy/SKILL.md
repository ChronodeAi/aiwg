---
name: growth-strategy
description: >-
  Use when a product's growth needs a strategy built from its actual growth model — how it acquires and keeps users today, the *constraint* currently limiting that loop, where the model runs out, and the methods that attack the constraint. Fires on "how do we grow this" or "growth has stalled." Not for building the flywheel diagram (`flywheel`), reducing churn specifically (`churn-reduction`), or finding the activation moment (`aha-moment`).
---

# Build a growth strategy from the growth model

## Step 1 — Describe the growth model as it works today

Get the numbers the user has — acquisition by channel, activation, retention, referral, revenue — and write how the product actually grows now: where new users come from, what makes them stay, what (if anything) makes them bring others. Describe the real loop, not the aspirational one; "we grow through word of mouth" needs a number behind it or it goes down as a hope.

Done when the model traces a user's path from arrival to (possibly) bringing the next user, with a number or an honest "unknown" at each step.

## Step 2 — Find the constraint

Walk the model and ask at each step: if this improved 20%, what happens to overall growth? The step where the answer is largest is the constraint. There is one — a list of five constraints means the model isn't understood yet. State it with the evidence, and note what's currently being worked on that *isn't* the constraint; that's the effort being wasted.

Done when one constraint is named with its 20%-test reasoning, and misdirected current effort is called out or cleared.

## Step 3 — Estimate the horizon

Every model runs out: the channel saturates, the audience empties, the trick stops working. Estimate where and roughly when this model slows — which step degrades first and what the ceiling looks like. A back-of-envelope number beats a paragraph of hedging.

Done when the horizon names the step that runs out first and a rough when or at-what-scale.

## Step 4 — Pick the methods

Propose 2–4 concrete methods that attack the Step 2 constraint — each with the mechanism (what number it moves and why), a rough cost, and its first experiment. Methods aimed at non-constraint steps don't make the list, however fashionable; that's the discipline the constraint buys.

Done when every method names its mechanism against the constraint and a first experiment, and none targets a non-constraint step.

## Step 5 — Distill the principle and watch for catalysts

Write one sentence the whole team can steer by, derived from the model and constraint — "every feature must shorten time-to-first-share," not "focus on growth." Then list the 2–3 signals that would change this strategy: a new channel opening, the constraint moving, the horizon arriving early. Each signal names what it would change.

Done when the principle is one steerable sentence and each catalyst names the strategy change it would trigger.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-growth-strategy-{product-slug}.md`. Never hand-build the path.

The doc holds: the growth model with numbers, the constraint and its evidence, the horizon, the methods with mechanisms and experiments, the principle, the catalysts.
