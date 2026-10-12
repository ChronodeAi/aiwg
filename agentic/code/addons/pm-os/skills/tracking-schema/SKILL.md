---
name: tracking-schema
description: >-
  Use when you have a UI or feature and metrics you want to measure, and need the analytics *events* and their schemas to instrument — each event tied to a real measurement question, with the properties needed to actually compute the metric. Not for defining what to measure (`success-metric`), querying data you already collect (`sql-from-spec`), or the full measurement workflow (`/measure`).
---

# Design analytics events from UI and metric questions

## Step 1 — List the measurement questions

From the metrics and behaviors, write the specific questions the tracking must answer ("what share of users who open the composer send a message?"). These, not the UI, decide what to capture.

Done when every metric or behavior is a concrete question the tracking must answer.

## Step 2 — Map the relevant UI actions

List the interactive elements and user actions in the UI that bear on those questions. Ignore elements no question touches.

Done when each question maps to the UI action(s) that would answer it.

## Step 3 — Spec each event

For each needed event: a name (verb_noun), the trigger (exactly when it fires), the property schema (what to capture), and the question it answers. Only events that serve a question make the list.

Done when every event has a name, a trigger, a schema, and the question it serves.

## Step 4 — Check each question is answerable

For every Step 1 question, confirm the specced events and properties actually let you compute it — the IDs, timestamps, and funnel markers it needs. Add any missing property.

Done when every question is answerable from the events as specced, or the missing property is added.

## Step 5 — Prune and flag gaps

Cut redundant or overlapping events. Flag any question the schema still can't answer and what it would take.

Done when no two events capture the same thing and any unanswerable question is named.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-tracking-schema-{feature-slug}.md`. Never hand-build the path.

The doc holds: the measurement questions, the event list (name, trigger, schema, question served), and any unanswerable gaps with what would close them.
