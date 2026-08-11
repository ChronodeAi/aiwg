---
name: requirements-from-talk
description: >-
  Use when you have a meeting transcript or interview notes and need a
  structured requirements list extracted from it — organized MECE, each
  requirement attributed to who said it, with the gaps and contradictions
  named rather than smoothed over. Also /prd Step 1a, one of three input
  modes. Not for a design asset instead of a transcript
  (`requirements-from-design`), reconciling requirements that already
  conflict (`requirements-reconcile`), or turning requirements into Cockburn
  use cases (`use-cases`).
---

# Extract structured requirements from a transcript

A transcript is full of requirements nobody wrote down as requirements — requests, complaints, and implied needs scattered across whoever was in the room. This skill pulls them out, sorts them, and names what it couldn't resolve instead of quietly resolving it for you.

Inside `/prd` this is Step 1a. Standalone, gather the transcript and any context that clarifies who's who.

## Step 1 — List every requirement, attributed

Read the transcript. List every requirement, request, and implied need, each attributed to who said it — pull the wording from what they actually said, don't paraphrase away the specificity.

Done when every requirement traces to a specific speaker and moment in the transcript, not a general theme.

## Step 2 — Group into MECE categories

Organize the list into categories (e.g. functional, non-functional, constraints, assumptions) so every requirement sits in exactly one category and no category ends up empty.

Done when every requirement has exactly one category and every category has at least one requirement.

## Step 3 — Name what the transcript didn't resolve

List the contradictions between participants, requirements that are over-specified (an engineering or design call that doesn't belong at this stage), requirements too vague to act on, and anything that looks like scope creep beyond the original ask. Don't resolve any of it — flag it for the reconcile step or a follow-up conversation.

Done when every contradiction, over/under-specification, and scope-creep candidate is named, none silently resolved.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-requirements-from-talk-{project-slug}.md`. Never hand-build the path.

The doc holds: the categorized requirements list with attribution, and the unresolved contradictions/over-under-specification/scope-creep list.
