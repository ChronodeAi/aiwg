---
name: interview-insights
description: >-
  Use when one customer interview transcript needs JTBD analysis — the *four forces* (pushes, pulls, habits, anxieties) coded with verbatim quotes, plus the jobs, struggles, and workarounds tagged by type and intensity. Also /research Step 2. Not for coding many interviews into a clusterable dataset (`jtbd-forces`), diagnosing a stuck deal with the forces (`diagnose-the-switch`), or reconstructing a work conversation (`transcript-insights`).
---

# Extract JTBD insights from one interview

The *four forces* explain why a person switches or stays: pushes (away from today), pulls (toward the new), habits (holding them in place), anxieties (about the change). Every force statement is coded from a verbatim quote — a force without a quote is the analyst talking, not the customer.

Inside `/research` this is Step 2: clean transcripts come in; the tagged insight set carries forward per interview.

## Step 1 — Get the transcript and place the person

Get the transcript and write the interviewee's context in 2–3 lines: who they are, their situation, and what solution decision (if any) they're weighing. This context is what the forces act on.

Done when the transcript is in hand and the context lines are written.

## Step 2 — Code the four forces with quotes

Walk the transcript and code every statement that expresses a force:

- **Pushes** as "When…" statements — situations driving them to seek change.
- **Pulls** as "So I can…" / "So I don't…" statements — outcomes drawing them forward.
- **Habits** as "When…" statements about what works in the current way.
- **Anxieties** as the worries, phrased as they phrased them.

Each statement carries its verbatim quote with location. Quote discipline: start where the thought begins, keep hedges and emotional language, never stitch lines from different parts of the interview. A force with nothing in the transcript gets an explicit "none found" — an empty category is a finding about the interview, not a gap to fill.

Done when every force has quoted statements or a none-found mark, and no statement lacks its quote.

## Step 3 — Tag the jobs, struggles, and workarounds

Extract what the person is trying to get done: **functional** jobs (the task), **emotional** jobs (how they want to feel), **social** jobs (how they want to be seen) — plus their struggles, current workarounds, and desired outcomes. Tag each with intensity: **high** (returned to repeatedly or said with emotion), **medium** (stated plainly), **low** (mentioned once in passing). Intensity comes from the transcript's behavior, not the analyst's sense of importance.

Done when every item has a type tag, an intensity tag with its evidence, and a quote.

## Step 4 — Write the decision picture

Summarize what drives this person's switch or stay: which force dominates (with the evidence), what the strongest anxiety is, and what would most likely move them — stated as a testable claim about this person, not a generalization about all users. One interview is one data point; say so where the user might be tempted to generalize.

Done when the dominant force is named with evidence and the summary claims nothing beyond this one interviewee.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-interview-insights-{interviewee-slug}.md`. Never hand-build the path.

The doc holds: the interviewee context, the four forces with quotes, the tagged jobs/struggles/workarounds with intensities, the decision picture.
