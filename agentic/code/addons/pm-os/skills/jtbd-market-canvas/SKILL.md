---
name: jtbd-market-canvas
description: >-
  Use when a product needs its market redefined through a Jobs-to-be-Done
  lens — from the traditional product category down to the abstracted job
  executor and the higher-order job the product actually gets hired for.
  Works from what you already know about the product, not new interview
  data — the JTBD Market Definition Canvas. Not for extracting forces from
  real interviews (`interview-insights`), clustering forces across a sample
  (`jtbd-forces`), or diagnosing where one specific buyer sits on the switch
  (`diagnose-the-switch`).
---

# Redefine the market through the JTBD lens

## Step 1 — Name the traditional market and its users

State the product's traditional category, then list every distinct type of user who gets value from it — as specific and comprehensive as possible, not a single generic "users."

Done when the traditional category is named and every distinct user type is listed.

## Step 2 — Abstract the job executor

Find the higher-order category that covers every user type from Step 1, and state why it fits all of them — this abstraction is what lets the job statement travel beyond the current product.

Done when one abstracted job-executor category covers every user type from Step 1 with a stated reason.

## Step 3 — Name the core function and its neighbors

Write the product's primary function as [verb] + [object] + [contextual clarifier] (e.g. "heat water to desired temperature"), then list the products used immediately before, during, or after it and what each does.

Done when the core function follows the verb-object-clarifier form and every adjacent product has its function named.

## Step 4 — Abstract the higher-order job

Synthesize the higher-level job the product actually gets hired for, in the same verb-object-clarifier form. Check it against three tests: does it cover the core function from Step 3, is it abstract enough that the solution could evolve without invalidating it, and could it be validated by watching real customers even if you haven't yet?

Done when the job statement passes all three tests, or the ones it fails are named explicitly.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-jtbd-market-canvas-{product-slug}.md`. Never hand-build the path.

The doc holds: the traditional market and user types, the abstracted job executor, the core function and its neighbors, and the higher-order job statement with its test results.
