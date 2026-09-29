---
name: ux-edge-cases
description: >-
  Use when a product brief needs a comprehensive edge-case sweep before
  build — a brief in, a scenario/expected-behavior table out, covering user
  types, contexts, failure inputs, load, integrations, security, and
  accessibility. Not for resolving one specific edge case already reported
  (`edge-case-balance`), or turning user stories into testable QA
  acceptance criteria (`ui-acceptance-criteria`).
---

# Sweep a product brief for edge cases before they become incidents

## Step 1 — Take the brief

Get the product or feature brief: the core flow, the intended users, and the primary happy path.

Done when the brief and its happy path are in hand.

## Step 2 — Sweep every dimension

For the brief, generate scenarios across each of: user types (new, power, disabled, unauthorized), contexts (device, connectivity, locale, time), invalid or malicious input, system failure and load spikes, interaction with other features or systems, security/privacy exposure, and accessibility (screen reader, keyboard-only, low vision).

Done when every dimension has at least one scenario, and the sweep totals 15-20+ distinct scenarios.

## Step 3 — Assign expected behavior

For each scenario, state exactly what the system should do — not just what could go wrong. A scenario without a stated expected behavior isn't actionable.

Done when every scenario in the sweep has an expected behavior, not just a description of the failure.

## Step 4 — Flag thin coverage

Reread the dimension list from Step 2 and flag any dimension with fewer than 2 scenarios or clear signs of a shallow pass — better to flag a gap than let it read as complete.

Done when every dimension is either well-covered or explicitly flagged as thin.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-ux-edge-cases-{feature-slug}.md`. Never hand-build the path.

The doc holds: the scenario/expected-behavior table, organized by dimension, with any thin-coverage flags called out.
