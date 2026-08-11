---
name: status-update
description: >-
  Use when you need to write a status update that gets read and acted on — one status line, wins/next/risks/asks, sized to the audience and *skimmable* so the first three lines carry the point. Not for critiquing an existing update (`exec-update-review`), building a presentation deck (`problem-deck`), or choosing the week's priorities (`weekly-top-3`).
---

# Write a status update people actually read

## Step 1 — Frame the update

Get the project, the audience (team / stakeholder / exec), and the period. Size the depth to the audience — exec ~100 words and outcomes only; team more tactical with tasks and owners.

Done when the audience and period are set and the target depth is chosen.

## Step 2 — Write the status line

One line: 🟢 / 🟡 / 🔴 plus one sentence on where things stand. Mark yellow or red honestly — an update that is only ever green stops being trusted.

Done when there is a single status line whose color matches reality.

## Step 3 — Fill the four sections

**Wins** (specific, with impact — "shipped X," not "made progress"), **Next** (with dates), **Risks** (with severity and a mitigation), **Asks** (each with an owner and a by-when). "Let me know if you have questions" is not an ask; "approve pricing by May 20" is.

Done when all four sections are filled and every ask names an owner and a date.

## Step 4 — Make it skimmable

Bold the key points, use bullets over paragraphs, add whitespace, and front-load so the status and any ask land in the first three lines.

Done when the update is scannable in ~30 seconds and the top three lines carry the status and any action needed.

## Step 5 — Match the voice

Read the relevant guide in `knowledge/Writing-Styles/` for tone — `writing-style-executive.md` for execs/leadership, `writing-style-internal.md` for team/colleagues — and adjust the draft to match.

Done when the tone matches the audience's writing-style guide.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-status-update-{project-slug}.md`. Never hand-build the path.

The doc holds: the framed audience and period, the ready-to-send update (status line + wins/next/risks/asks with owned asks), tone-matched to the audience.
