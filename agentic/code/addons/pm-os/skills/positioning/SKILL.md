---
name: positioning
description: >-
  Use when a product needs a positioning statement and value proposition —
  from a competitive analysis, a stated value proposition, or both — a
  Geoffrey Moore–style statement that's falsifiable and outcome-led, not
  feature-led. Not for the underlying competitive analysis itself
  (`netmba-competitor-analysis`), the full structured strategy document
  (`product-strategy`), or the complete strategy workflow (`/strategy`).
---

# Write a Geoffrey Moore positioning statement

## Step 1 — Extract the differentiators

From a competitive analysis, a stated value proposition, or both, pull 3–5 things that set the product apart — each with why it matters to the customer, not just that it exists.

Done when 3–5 differentiators are listed, each with a stated customer benefit, not just a feature name.

## Step 2 — Name the target and their unmet need

One specific segment, not "everyone," and the need stated in the customer's words, not the product's.

Done when the target customer is one specific segment and the unmet need is in the customer's terms.

## Step 3 — Write the canonical statement

**For** [target customer] **who** [unmet need], **[product]** **is a** [category] **that** [outcome]. **Unlike** [competitor/status quo], **it** [outcome-focused differentiation with a proof reference]. ≤60 words, no jargon ("revolutionary," "cutting-edge"), every claim testable.

Done when the statement follows the form, stays under 60 words, and every claim in it is falsifiable.

## Step 4 — Write the two variants

**Executive-readout** (crisp, high-level, ≤35 words) and **sales-enablement** (customer-centric, objection-aware, ≤35 words) — both derived from the canonical statement, not written fresh.

Done when both variants are ≤35 words and each traces to a specific clause in the canonical statement.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-positioning-{product-slug}.md`. Never hand-build the path.

The doc holds: the differentiators, the target customer and unmet need, the canonical statement, and the two variants.
