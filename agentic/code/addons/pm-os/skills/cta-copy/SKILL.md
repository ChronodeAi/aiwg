---
name: cta-copy
description: >-
  Use when a product page needs call-to-action copy — a product in, 12
  tight CTAs out across four proven strategies (match the feeling,
  actionable next step, handle the objection, make it specific), each
  6-35 characters. Not for the underlying value proposition the CTA sits
  on top of (`positioning`), or restructuring existing text for logical
  clarity (`pyramid-principle`).
---

# Write 12 tight CTAs across four strategies

## Step 1 — Take the product

Get the product being written for.

Done when the product is stated.

## Step 2 — Write 3 CTAs per strategy

For each of the four strategies — match the feeling, actionable next step, handle the objection, make it specific — write 3 unique CTAs tailored to this product. 12 total.

Done when all four strategies have exactly 3 CTAs each, and none of the 12 is generic enough to apply to a different product.

## Step 3 — Enforce the length constraint

Each CTA is 6-35 characters including spaces, averaging around 25. State the character count next to each one.

Done when every CTA's character count is stated and falls within 6-35.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-cta-copy-{product-slug}.md`. Never hand-build the path.

The doc holds: the 12 CTAs grouped by strategy, each with its character count.
