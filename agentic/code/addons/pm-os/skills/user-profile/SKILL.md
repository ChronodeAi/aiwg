---
name: user-profile
description: >-
  Use when a persona is buzzwords — "Sarah, 34, tech-savvy marketer" — and the PM needs it upgraded into an actionable profile: real *tasks*, constraints, and scenarios, with every claim either grounded in data or flagged as assumed. Not for building a first persona from research (`proto-persona`) or emotional/behavioral mapping (`create-empathy-maps`).
---

# Upgrade a shallow persona into tasks and constraints

## Step 1 — Get the persona and the real data

Ask for the existing persona and whatever real data exists behind it — interviews, support tickets, analytics, sales notes. Mark each source real or none. If there is no data at all, say so up front: the output will be a structured set of assumptions to validate, not a profile to trust.

Done when the persona is in hand and every data source is listed and marked, or "no data" is stated.

## Step 2 — Strike the lines that can't change a decision

Go through the persona line by line and strike everything that could not change a design decision — age, stock photo traits, "tech-savvy," "values efficiency." Keep what survives.

Done when every struck line is listed, and each surviving line names a decision it could plausibly affect.

## Step 3 — Write the tasks

Write 5–7 concrete tasks this person must get done in the product's territory, phrased in their world ("get the quarterly forecast to the leadership review by Thursday"), plus the emotional stakes (what they fear or want to feel) and the social stakes (how they need to look to whom). Ground each in a Step 1 source — or flag it **assumed**.

Done when every task and stake carries either a source or an assumed flag.

## Step 4 — Map the constraints

For each constraint that binds this person — decision authority, available time, tools they're locked into, knowledge gaps, org rules — write the constraint and the design decision it forces ("no admin rights → no install step," "lives in Slack → alerts go there or nowhere"). A constraint with no design consequence gets struck like a Step 2 adjective.

Done when every constraint names the decision it forces, sourced or flagged assumed.

## Step 5 — Ground it in scenarios

Write 2–3 scenarios: situation, goal, the binding constraint, how they handle it today, and where it hurts. Concrete details — a day, a deadline, a named tool — not "sometimes users need to."

Done when each scenario uses concrete details and features at least one Step 3 task and one Step 4 constraint.

## Step 6 — Turn the assumed flags into a validation list

Collect every assumed flag from Steps 3–5 into the research-gap list, each with the cheapest way to check it: an analytics query, three customer calls, a ticket search. This list is the profile's honesty ledger — a profile with no flags and no data is fiction.

Done when every assumed flag appears in the list with a check, and none is left inside the profile unmarked.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-user-profile-{persona-slug}.md`. Never hand-build the path.

The doc holds: the data-source list, the struck lines, the tasks and stakes, the constraints with consequences, the scenarios, the validation list.
