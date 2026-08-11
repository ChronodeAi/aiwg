---
name: interview-notes
description: >-
  Use when a cleaned interview transcript needs atomized, citable notes
  under a chosen framework (Chronological, Topical, AEIOU, or Empathy Map)
  — a transcript and a mode in, one-idea-per-note tables out, each note
  quoted and timestamped. Not for JTBD-specific force extraction
  (`interview-insights`), cleaning the raw transcript first
  (`transcript-cleanup`), or writing the guide that produced the interview
  (`mom-test-guide`).
---

# Atomize a transcript into citable notes

## Step 1 — Take the transcript and the mode

Get the cleaned transcript and the note-taking mode: Chronological, Topical, AEIOU (Activities, Environments, Interactions, Objects, Users), or Empathy Map (Thinks, Feels, Says, Does, Sees, Hears, Pains, Goals).

Done when the transcript and a named mode are both in hand.

## Step 2 — Read fully before atomizing

Read the entire transcript once for context before extracting a single note — a note pulled before the interviewer's full arc is understood risks missing the point behind the quote.

Done when the full transcript has been read once, before any note is written.

## Step 3 — Atomize into one-idea notes

Extract notes under 250 characters, one idea each. For each: start where the thought begins and continue until it's fully expressed, include the reasoning behind a claim (not just its conclusion), keep hedges and qualifiers, keep emotional language, and cite with participant ID and approximate timestamp (`[P02 ~14:30]`). Never combine statements from different parts of the transcript into one note; split any quote longer than 3 sentences into separate notes.

Done when every note is under 250 characters, cites a participant and timestamp, and holds exactly one idea.

## Step 4 — Assemble by mode

Organize the notes into tables matching the chosen mode's categories (e.g. one table per AEIOU category, one per Empathy Map category). One column per table, one note per row.

Done when every note is placed in the table matching its mode category, and every category the mode requires has its own table.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-interview-notes-{participant-slug}.md`. Never hand-build the path.

The doc holds: the note tables organized by the chosen mode's categories.
