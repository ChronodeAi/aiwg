---
name: product-assumptions
description: >-
  Use when a product strategy's hidden bets need writing down as falsifiable
  claims — a core problem, product description, and target user in, "We believe
  that…" statements across desirability, feasibility, viability, and usability
  out, each with its impact if wrong. Also `/assumptions` Step 1. Not for ranking
  which of them to test first (`risky-assumptions`), finding the cheapest signal
  that would settle one (`work-backwards`), or turning a problem into a single
  measurable hypothesis (`product-hypothesis`).
---

# Surface the falsifiable bets under a product strategy

## Step 1 — Take the three inputs

Ask for the core problem, the product description, and the target user. Where an input is vague or missing, carry on with a prudent industry-standard default rather than stalling, and note the gap.

Done when all three inputs are stated and every gap covered by a default is named.

## Step 2 — Write five claims per lens

Write at least five assumptions under each of Desirability, Feasibility, Viability, and Usability. Each is a numbered item with two lines:

- **Statement:** opens "We believe that…", one falsifiable claim, 35 words maximum, one idea only.
- **Impact if wrong:** one sentence on adoption, cost, timeline, risk, or strategy.

Each lens has its own territory:

- **Desirability** — problem severity, willingness to pay or switch, triggers, frequency, decision makers, trust.
- **Feasibility** — technical risk, data availability, integration complexity, reliability, security and compliance, scalability, support load.
- **Viability** — pricing, margin, TAM/SAM, sales-cycle length, channel fit, retention, payback, partner take rates.
- **Usability** — task success, learnability, accessibility, error tolerance, onboarding, navigation, device context, latency.

A claim is falsifiable when it carries a threshold, segment, timeframe, or condition someone could go and measure — "at least 20%", "within 90 days", "for new SMB admins", "under normal network conditions".

Done when every lens holds five or more claims, every Statement is one idea under 35 words carrying a measurable threshold, segment, timeframe, or condition, and every claim has its impact-if-wrong line.

## Step 3 — Strike the restatements and the unfalsifiable

Read the four lenses against each other. Strike any claim that restates another under a different label, and any claim no observation could disprove.

Done when no surviving claim repeats another lens, and for each survivor you can state the observation that would kill it.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-product-assumptions-{product-slug}.md`. Never hand-build the path.

The doc holds: the four lenses with their claims and impact-if-wrong lines, and a closing summary naming the inputs that were missing and the defaults used in their place.
