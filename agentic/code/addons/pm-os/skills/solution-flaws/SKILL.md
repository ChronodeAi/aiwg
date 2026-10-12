---
name: solution-flaws
description: >-
  Use when practicing problem-analysis judgment by generating solutions
  that sound pragmatic but would actually fail — customer notes in, three
  plausible-but-flawed solutions out, each with the subtle reason it
  doesn't hold up. Not for triaging a real reported bug against committed
  work (`bug-triage`), or classifying a real decision's reversibility
  (`two-way-door`).
---

# Generate plausible-but-flawed solutions to sharpen problem analysis

## Step 1 — Break down the customer notes

Extract the core problem(s), the underlying assumptions, the implicit needs, and the affected stakeholders from the customer notes.

Done when the core problem, assumptions, implicit needs, and stakeholders are all named.

## Step 2 — Generate three plausible-but-flawed solutions

Write three solutions that sound realistic and implementable but would fail or make things worse — each misinterprets a need, adds unnecessary complexity, or ignores a real constraint. No absurd or comical options; the flaw has to be subtle enough to not be obvious on first read.

Done when three solutions are written, each realistic enough to be mistaken for a good one on first read.

## Step 3 — Explain why each one fails

For each solution, name the specific gap between what it appears to solve and what it actually leaves unaddressed or breaks.

Done when every solution has a stated failure reason distinct from the other two, not a repeated generic critique.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-solution-flaws-{topic-slug}.md`. Never hand-build the path.

The doc holds: the problem breakdown and the three flawed solutions, each with its stated failure reason.
