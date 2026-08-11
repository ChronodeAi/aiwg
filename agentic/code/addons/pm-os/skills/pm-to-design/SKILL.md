---
name: pm-to-design
description: >-
  Use when a PM's context (goals, success metrics, business requirements)
  needs translating into concrete design constraints — especially the
  constraints a PM assumes but never states. Not for the single-screen
  kickoff sketch (`app-design-foundation`), full flow sketches
  (`wireframe-sketch`), or reverse-engineering requirements from a design
  that already exists (`requirements-from-design`).
---

# Surface the constraints a PM assumed but never said

## Step 1 — Take the PM context

Get the PM's context: user goals, success metrics, business requirements, and any stated technical or timeline constraints.

Done when goals, success metrics, and business requirements are all in hand.

## Step 2 — Extract explicit constraints

Pull out what's directly stated: user needs and jobs-to-be-done, technical limitations (platform, performance, integrations), business rules (compliance, pricing, operations), and timeline/scope boundaries (must-have vs. won't-have).

Done when every explicit constraint category has either a stated constraint or is confirmed not addressed.

## Step 3 — Surface implicit constraints

Name what the PM context assumes but never states: platform conventions (iOS/Material/web patterns), existing product or industry patterns users expect, performance expectations (load time, responsiveness), accessibility floor (WCAG level), brand/design-system requirements, and privacy/security handling of sensitive data.

Done when every implicit category is made explicit with a concrete, statable requirement — not left as an assumption.

## Step 4 — Translate metrics into requirements

For each success metric, name the UX outcome it requires, the friction it implies removing, and a concrete design requirement that would move it.

Done when every success metric has a corresponding design requirement, not just a restated goal.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-pm-to-design-{feature-slug}.md`. Never hand-build the path.

The doc holds: explicit constraints, implicit constraints made explicit, and the metric-to-requirement translation.
