---
name: aha-moment
description: >-
  Use when you have usage/retention data and an app description and need to
  find the specific action or condition that predicts long-term engagement
  — the moment users first get the product's value. Feeds `growth-strategy`'s
  loop diagnosis and `onboarding-redesign`'s transformation design. Not for
  building the growth strategy around it (`growth-strategy`), redesigning
  the onboarding path to reach it faster (`onboarding-redesign`), or
  diagnosing why users churn after activation (`churn-reduction`).
---

# Find the action that predicts retention

## Step 1 — Take the app description and user data

Get the app description and the available usage/retention data — session logs, cohort retention, or churned-vs-retained user actions.

Done when the app description and at least one form of usage data are in hand.

## Step 2 — Generate candidate conditions

From the app description, name 3-5 actions or conditions users plausibly need to experience the app's value. For each, explain why it should predict activation.

Done when 3-5 candidates are named, each with a stated reason it should matter.

## Step 3 — Test each candidate against the data

For each candidate, check the data: what fraction of retained users performed it, and what fraction of churned users didn't. Rank candidates by how cleanly they split retained from churned.

Done when every candidate has a stated retained/churned split, or is marked untestable due to missing data.

## Step 4 — Name the activation moment

Pick the candidate with the cleanest split as the activation moment, and state the specific action or condition in one sentence.

Done when one activation moment is named with its supporting split, distinct from the other candidates considered.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-aha-moment-{app-slug}.md`. Never hand-build the path.

The doc holds: the candidates considered, each with its retained/churned split, and the named activation moment.
