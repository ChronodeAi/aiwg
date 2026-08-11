---
name: gherkin-stories
description: >-
  Use when you have a use-case list (or a persona, goals, and product
  context, if no use cases exist yet) and need INVEST-compliant user
  stories with embedded Given/When/Then acceptance criteria — atomic,
  traceable, and covering the edge case as well as the happy path. Also
  `/prd` Step 4b — the Gherkin mode, alternative to Step 4a's plain
  `user-stories` — taking Step 3's use-case list as input. Not for plain
  role-goal-benefit stories with no embedded scenarios (`user-stories`),
  translating stories into testable UI QA specs
  (`ui-acceptance-criteria`), or defining the use cases themselves
  (`use-cases`).
---

# Write one atomic story per use case, scenarios embedded

## Step 1 — Take the use-case list

Get the use-case list (actor, goal, scenario per case) from `/prd` Step 3, or — standalone — the persona, their goals, and product context.

Done when every use case or goal in scope is identified as a story source.

## Step 2 — Write one atomic story per source

For each source, write a summary and the As-a/I-want/So-that use case, with exactly one trigger and one outcome for the happy path. If a source needs more than one trigger or outcome to describe it, split it into separate stories instead of forcing them together.

Done when every story has exactly one trigger and one outcome, and no story required merging two distinct outcomes.

## Step 3 — Add Gherkin acceptance criteria

For each story, write the happy-path scenario as Given/When/Then, plus one edge-or-negative scenario (a risk, error, or permission case) also as Given/When/Then.

Done when every story has both a happy-path and an edge/negative Gherkin scenario, each independently testable.

## Step 4 — Note what QA and engineering need

For each story, note any non-functional requirement (performance, security, accessibility), the event or property to instrument if relevant, dependencies (APIs, teams, flags), and anything explicitly out of scope.

Done when every story's notes are filled in or explicitly marked not applicable — never silently skipped.

## Step 5 — Trace each story to its source

Build a table mapping each use case or goal to the story ID(s) that cover it, and how the acceptance criteria prove it.

Done when every source from Step 1 has at least one story, and every story traces to a named source.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-gherkin-stories-{initiative-slug}.md`. Never hand-build the path.

The doc holds: the numbered stories with their Gherkin scenarios and notes, and the traceability table.
