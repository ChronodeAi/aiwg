---
name: jtbd-jobs
description: >-
  Use when you have a single transcript or set of notes and just need job
  stories written from it — no forces, no intensity tagging, just the
  situation/motivation/outcome pattern. Not for the full four-forces JTBD
  extraction (`interview-insights`), a buyer-switch diagnosis
  (`diagnose-the-switch`), or clustering forces across many interviews
  (`jtbd-forces`).
---

# Write job stories from a transcript

## Step 1 — Find the underlying problems

Read the transcript for pain points, frustrations, inefficiencies, and any workaround or makeshift solution the person has already built — a job story lives here even when never stated outright.

Done when at least one candidate situation is identified per distinct problem the person describes.

## Step 2 — Write one job story per problem

For each: **When** [situation], **I want to** [motivation], **so I can** [expected outcome]. Ground the situation and motivation in what was actually said or clearly implied — don't invent a want the transcript doesn't support.

Done when every job story traces to a specific moment in the transcript and follows the When / want-to / so-I-can form.

## Step 3 — Cite the evidence

For each job story, note the quote it's drawn from — verbatim, with participant ID and approximate timestamp where available.

Done when every job story has a citation.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-jtbd-jobs-{interviewee-slug}.md`. Never hand-build the path.

The doc holds: the job stories with their citations.
