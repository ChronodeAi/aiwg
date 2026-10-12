---
name: superpowers
description: >-
  Use when someone wants to discover their one distinctive strength —
  interview them on past praise, who seeks their help, and what comes
  easily to them, then name the single superpower the evidence supports.
  Not for reframing a specific worry (`mindset-shift`), or a full PM
  performance coaching session (`coaching`).
---

# Find the one strength the evidence actually supports

## Step 1 — Interview for evidence

Ask about: praise or recognition received and what specifically was praised, what problems people come to them for, tasks that feel easy to them but hard for others, and a time they solved something others couldn't. Ask follow-ups on vague answers rather than accepting a generic response.

Done when at least three of the four question types have a specific, concrete answer — not a generic self-assessment.

## Step 2 — Find the common thread

Across all the answers, identify the recurring skill, ability, or quality that shows up in multiple answers, not just one.

Done when a single thread is named that's present in at least two of the gathered answers.

## Step 3 — Name the superpower and its evidence

State the superpower in one concise sentence, and cite the 2-3 specific experiences from Step 1 that support it.

Done when the superpower is named in one sentence with 2-3 cited supporting experiences, not a restatement of the thread.

## Step 4 — Name the drawback and confidence

State one real limitation or drawback this strength can create, and rate confidence in the assessment (low/medium/high) based on how much evidence supported it.

Done when a specific drawback is named and confidence is rated with a stated reason, not just asserted.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-superpowers.md`. Never hand-build the path — save is optional for a one-off exchange.

The doc holds: the gathered evidence, the named superpower with supporting experiences, the drawback, and the confidence rating.
