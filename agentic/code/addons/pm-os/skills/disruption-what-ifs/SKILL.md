---
name: disruption-what-ifs
description: >-
  Use when an incumbent company or product needs counter-positioning
  ideation — assumption-breaking "what if" questions spanning technology,
  business model, customer experience, and market that expose where a new
  entrant could win. Not for the table-stakes match/differentiate/leapfrog
  call (`parity-vs-differentiation`), portfolio-gap growth ideas
  (`pioneer-migrator-settler`), or the four-view adaptive plan
  (`scenario-plan`).
---

# Break the incumbent's assumptions, not just their features

## Step 1 — Take the incumbent

Get the company or product to analyze.

Done when the incumbent is specific enough to analyze, not a whole industry.

## Step 2 — Name what makes them successful

Analyze their revenue model, core product elements, and competitive advantages — what a challenger would actually have to break to win.

Done when revenue model, core elements, and competitive advantage are all named specifically.

## Step 3 — Generate assumption-breaking what-ifs

Write 15-20 "what if" questions spanning technology, business model, customer experience, market expansion, and regulatory change — each targeting a specific assumption from Step 2, not a generic industry question.

Done when at least 15 questions are written, spanning at least 4 of the 5 dimensions, each traceable to a named assumption from Step 2.

## Step 4 — Pick the strongest counter-positioning moves

From the what-ifs, select the 3-5 with the clearest path to a real competitive advantage for a new entrant, and state the move each implies.

Done when 3-5 what-ifs are selected, each with a stated concrete move a new entrant could actually take.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-disruption-what-ifs-{company-slug}.md`. Never hand-build the path.

The doc holds: the incumbent analysis, the full what-if list by dimension, and the selected counter-positioning moves.
