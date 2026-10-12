---
name: jtbd-forces
description: >-
  Use when multiple coded interviews (JTBD insight sets, one per participant)
  need to become one clusterable dataset — pushes, pulls, habits, and
  anxieties coded consistently across the sample so patterns become visible.
  Also /research Step 3, taking the Step 2 insight sets as input. Not for
  extracting the four forces from one interview (`interview-insights`),
  diagnosing one buyer's stuck switch (`diagnose-the-switch`), or writing a
  quick job story (`jtbd-jobs`).
---

# Cluster JTBD forces across interviews

One interview's forces are a data point; the pattern is in what repeats across the sample. This skill codes force statements consistently across every interview so they become one clusterable dataset instead of N separate write-ups.

Inside `/research` this is Step 3: the tagged insight sets from Step 2 come in, one per interview.

## Step 1 — Build the coding matrix

Lay interviews as rows, forces as columns. Take the first interview's forces as the starting columns; for each subsequent interview, code an existing column with a 1 if the force matches, or add a new column if it's genuinely new.

Done when every interview is a row and every distinct force encountered is a column, coded 1/0.

## Step 2 — Decide what's the same force

Where two columns look close, decide whether they're the same concept stated differently or genuinely distinct — merge the former, keep the latter separate. A merge without a stated reason is guessing.

Done when every merge decision has a one-line reason, and no two surviving columns describe the same concept under different names.

## Step 3 — Label and rank

Give each surviving column an abstract label that covers every example beneath it, then rank columns by how many interviews they appear in — the widest-spread forces are the strongest signal.

Done when every column has a label and the ranking is visible.

## Step 4 — Flag what's unique

Name any interview that introduced a force found nowhere else — a one-off force is either noise or the edge of an emerging pattern, not something to discard silently.

Done when every unique force is listed with the interview it came from.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-jtbd-forces-{project-slug}.md`. Never hand-build the path.

The doc holds: the coding matrix, the merge decisions, the ranked labels, and the unique-force list.
