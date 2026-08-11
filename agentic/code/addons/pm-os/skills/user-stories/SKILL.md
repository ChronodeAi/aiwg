---
name: user-stories
description: >-
  Use when you have a use-case list (or initiative requirements, if no use
  cases exist yet) and need agile-style role-goal-benefit user stories broken
  out and traceable back to their source. Also `/prd` Step 4a — the basic
  mode, alternative to Step 4b's Gherkin-embedded stories — taking Step 3's
  use-case list as input. Not for Gherkin/Given-When-Then acceptance criteria
  embedded in the story itself (`gherkin-stories`), translating stories into
  testable UI QA specs (`ui-acceptance-criteria`), or defining the use cases
  themselves (`use-cases`).
---

# Write one atomic story per use case

## Step 1 — Take the use-case list

Get the use-case list (actor, goal, scenario per case) from `/prd` Step 3, or — standalone — the initiative context and functionality description, plus a story template if one is required.

Done when every use case or requirement in scope is identified as a story source.

## Step 2 — Write one atomic story per source

For each use case or distinct piece of functionality, write a story: "As a [user], I want to [goal], so that [value]." One outcome per story — if a source implies two outcomes, split it into two stories rather than bundling. Include testable acceptance criteria.

Done when every story has exactly one outcome, a stated user and value, and testable acceptance criteria.

## Step 3 — Trace each story to its source

Note which use case or requirement each story came from.

Done when every story is traceable to the use case or requirement that produced it, and every source has at least one story.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-user-stories-{initiative-slug}.md`. Never hand-build the path.

The doc holds: the numbered stories, each with its acceptance criteria and source trace.
