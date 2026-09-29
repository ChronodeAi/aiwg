---
name: limit-strategy
description: >-
  Use when a strategy needs sharpened by envisioning its idealized end
  state and backcasting to today — a strategy draft or problem, plus the
  crux behind it, in, a limit state with convergence milestones and an
  execution plan out. Also `/strategy` Step 2, taking the Step 0 crux and
  Step 1b strategy draft as input. Not for mapping value generators in the
  current state (`value-chain`), scanning external trends for new
  opportunities (`inflection-scan`), or building the strategy document
  itself (`product-strategy`).
---

# Backcast a strategy from its limit state

## Step 1 — Define the growth variable

From the strategy draft and crux (or a problem statement), name the one dimension that expands over time and matters most — users, compute, market size, revenue per account. Everything else in this analysis is relative to it.

Done when one growth variable is named and tied to the crux it's meant to resolve.

## Step 2 — Envision the limit state

Describe the fully mature, frictionless version of the product if the growth variable expanded without limit — ignore today's constraints. List the structural properties that must exist for that state to be real (what's automated, what's seamless, what stakeholders no longer need to do manually).

Done when the limit state is described concretely and its required structural properties are listed.

## Step 3 — Estimate and accelerate convergence

Estimate the growth curve from today's baseline to the limit, with milestones at 10/25/50/75/90% and a rough date or trigger for each. Then name the biggest levers — technical, organizational, go-to-market — that would steepen the curve, prioritized by impact.

Done when milestones are dated or trigger-bound, and levers are prioritized by how much they'd accelerate convergence.

## Step 4 — Validate assumptions and derive the plan

List the critical assumptions behind the growth and convergence estimates, each with what evidence would prove or disprove it. Then write a one-sentence vision statement and a 3-phase execution plan (Foundation, Acceleration, Optimization) with resourcing.

Done when every critical assumption has a validation method, and the execution plan has all three phases with resourcing.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-limit-strategy-{product-slug}.md`. Never hand-build the path.

The doc holds: the growth variable, the limit state description, the convergence milestones with acceleration levers, the validated assumptions, and the 3-phase execution plan.
