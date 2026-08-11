---
name: ui-acceptance-criteria
description: >-
  Use when you have user stories and need testable, measurable UI acceptance
  criteria covering every state, breakpoint, and edge case — vague criteria
  like "looks good" or "works well" replaced with specifics QA can validate
  without ambiguity. Also `/prd` Step 5, only when the PRD has UI scope,
  taking Step 4's stories as input. Not for sweeping a brief for edge cases
  before stories exist (`ux-edge-cases`), resolving one specific edge case
  (`edge-case-balance`), or writing the underlying story these criteria
  attach to (`user-stories`).
---

# Turn vague UI intent into testable criteria

## Step 1 — Take the stories and available context

Get the user stories in scope. Pull in whatever's available — mockups, user flows, technical constraints, accessibility requirements — but don't block on any of them; a story alone is enough to start.

Done when every story in scope is identified as needing acceptance criteria.

## Step 2 — Enumerate every state and breakpoint

For each story, list its UI states (default, loading, empty, error, success, disabled) and responsive breakpoints (mobile, tablet, desktop). Flag any state the story doesn't obviously cover, rather than skipping it.

Done when every story has its full state and breakpoint list, with no state assumed away.

## Step 3 — Add edge cases per state

For each state, note what happens on long or short text, special characters, extreme numbers, missing data, and rapid or unusual input.

Done when every state has at least one edge case considered, and each either has a criterion or is explicitly marked out of scope.

## Step 4 — Write each criterion as Given/When/Then

For every state, breakpoint, and edge case from Steps 2-3, write one Given/When/Then criterion stating the precondition, the trigger, and the exact observable outcome — never a subjective description.

Done when every listed state, breakpoint, and edge case has a Given/When/Then criterion, and none contains a subjective term ("good," "clean," "works well").

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-ui-acceptance-criteria-{feature-slug}.md`. Never hand-build the path.

The doc holds: acceptance criteria grouped by story, each covering its states, breakpoints, and edge cases in Given/When/Then format.
