---
name: value-chain
description: >-
  Use when a strategy needs checked against where value actually gets
  generated — a product/industry (or a strategy draft) in, a value chain
  from end-user needs to core value generators out, with the strategy's
  pillars checked against the leverage points that chain reveals. Also
  `/strategy` Step 3. Not for backcasting from an idealized end state
  (`limit-strategy`), scanning external trends for new opportunities
  (`inflection-scan`), or building the strategy document itself
  (`product-strategy`).
---

# Map the value chain and check the strategy targets it

## Step 1 — Take the inputs

Get the product or service, its industry, and end-user needs. If this follows `/strategy` Steps 1-2, take the accumulated strategy draft too — the chain has to be checked against something.

Done when the product, industry, and end-user needs are in hand (plus the strategy draft, if one exists).

## Step 2 — Break down the chain

Starting from end-user needs, work backward through every value-adding step to the most basic inputs (raw materials, compute, capital). Build a hierarchical breakdown, not a flat list.

Done when the chain runs unbroken from end-user needs to basic inputs.

## Step 3 — Name core value generators and vulnerabilities

Identify the elements the business would collapse without — proprietary tech, a unique capability, a network effect, a hard-to-replicate partnership — and why a competitor can't easily copy each one. Separately, flag any link in the chain exposed to disruption.

Done when every core value generator has a stated reason it's hard to replicate, and vulnerabilities are named.

## Step 4 — Confirm the strategy targets the leverage points

If a strategy draft exists, check each of its pillars or moves against the core value generators from Step 3: does it invest in one, or does it drift toward a low-leverage part of the chain? Flag any mismatch by name.

Done when every strategy pillar is checked against a core value generator, and any low-leverage mismatch is named explicitly — not silently passed over.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-value-chain-{product-slug}.md`. Never hand-build the path.

The doc holds: the value chain breakdown, the core value generators with vulnerabilities, and the leverage-point check against the strategy (where one exists).
