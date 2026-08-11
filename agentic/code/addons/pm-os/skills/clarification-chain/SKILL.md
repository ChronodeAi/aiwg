---
name: clarification-chain
description: >-
  Use when someone calls a thing immeasurable — quality, engagement, security, brand, innovation — and it has to become countable anyway: three *links* from detectable consequence to observable amount to a tracking method. Also /measure Step 1, feeding the observables the rest of the workflow decomposes. Not for breaking an already-named quantity into estimable factors (`fermi-decomposition`), pricing whether the measurement is worth running (`value-of-information`), or setting one primary metric for a specific change (`success-metric`).
---

# Turn an intangible into observable quantities

The chain has three links, and each one only holds if the link before it did. Walk them in order — a metric proposed before Link 1 is a metric nobody can defend.

## Step 1 — Name the intangible exactly

Get the user's own words for what supposedly can't be measured, then narrow them. "Culture" is unworkable; "whether engineers feel safe shipping on Friday" is a chain you can walk. Ask which decision would change if the number moved — an intangible nobody would act on doesn't need measuring.

Done when the intangible is one sentence and the user has named the decision the measurement would inform.

## Step 2 — Link 1: find the detectable consequences

Ask, per stakeholder: if this improved, what would they notice? Work through customers, employees, managers, and the system itself — each sees a different shadow of the same thing. If no one would notice any difference, say so plainly: the concept may not be doing any work, and that finding ends the session honestly.

Done when at least three stakeholders have a specific observable consequence, each phrased as something a person or a log could witness.

## Step 3 — Link 2: convert each consequence to an amount

Every observation becomes a count, a rate, or a scale. "Fewer complaints" becomes complaints per 1,000 orders. "People feel safe experimenting" becomes a 1–10 survey item. Sort them as you go:

- **Input indicators** measure the state of the intangible itself (survey items, % of managers allocating experiment time).
- **Output indicators** measure results of having it (turnover rate, breaches per quarter).

When the goal is to change a culture or environment, inputs lead — outputs lag by months and are the easier ones to game.

Done when every consequence from Step 2 has an amount, and each is tagged input or output with the inputs listed first.

## Step 4 — Link 3: name where each number comes from

For each amount, state the source and the cadence: HRIS export monthly, SIEM logs weekly, quarterly survey, pen-test report. An amount with no source is a wish. Where no source exists yet, say what would have to be built and how long it takes.

Done when every metric has a named system or instrument and a collection frequency, or an explicit "doesn't exist yet — here's what it takes".

## Step 5 — Test the chain against gaming

Ask two questions of the finished set. Would improving these numbers actually improve the underlying thing? And how could someone move every number while the intangible got worse? Name the blind spots out loud — a chain presented without them invites the gaming it failed to anticipate.

Done when the set has a stated verdict (captures it / partially captures it) and at least one named way the metrics could improve while the intangible doesn't.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-clarification-{intangible-slug}.md`. Never hand-build the path.

The doc holds: the intangible and the decision it informs, the stakeholder consequences, the input and output indicators with their amounts, the source and cadence per metric, and the gaming blind spots.
