---
name: research-synthesis
description: >-
  Use when a PM has *scattered* research inputs — interview notes, support tickets, NPS comments, analytics, Slack anecdotes — and needs them merged into a few evidenced insights that answer specific product questions. Also fires on "what is all this feedback telling us?". Not for a single interview transcript (`interview-insights`), one conversation (`transcript-insights`), or survey-only data (`survey-to-actions`).
---

# Triangulate scattered research into evidenced insights

## Step 1 — Get the questions and inventory the inputs

Ask for the product or design questions the synthesis must answer — the synthesis is graded against these, so get them before touching the data. Then list every input: source type, date range, user segment, rough volume.

Done when the questions are written down and every input has a source, date, and segment — or is marked unknown.

## Step 2 — Extract one-line observations

Go through each input and pull out individual observations, one line each, tagged with its source. Keep verbatim quotes in the user's words — start where the thought begins, keep hedges and emotional language, cite the source and participant. Mark each line as observed behavior or stated preference; the two are not equal evidence.

Done when every input has contributed at least one line or is explicitly set aside with a one-sentence reason.

## Step 3 — Cluster across sources

Group the lines into candidate insights. A candidate that triangulates — supported by lines from two or more independent sources — becomes an insight. A candidate with only one source goes to a weak-signals list, not the trash: single mentions are how the next big problem first shows up.

Done when every insight lists its supporting lines by source, and no two insights say the same thing in different words.

## Step 4 — Grade confidence and surface conflicts

Grade each insight: **high** (3+ sources, or behavior plus stated preference agreeing), **medium** (2 sources, or one source with many instances), **low** (weak signal promoted for relevance). Where sources disagree, write the conflict out — "support tickets say X, interviews say Y" — with the most likely explanation (different segments, stated vs. observed, old vs. new data). Never smooth a conflict over.

Done when every insight carries a grade with its reason, and every conflict in the data is stated rather than dropped.

## Step 5 — Answer the questions

Map the insights back to each question from Step 1. Where the research answers it, say so with the insight and its confidence. Where it doesn't, say "the research doesn't answer this" — an honest gap beats a stretched insight.

Done when every question has either an evidenced answer or an explicit gap.

## Step 6 — Name the next research move

For the biggest gap or the most consequential conflict, name the single cheapest study that would resolve it: method, who to talk to or what to measure, and what answer would change a decision.

Done when the move names a method and a decision it would change — not "do more research."

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-research-synthesis-{topic-slug}.md`. Never hand-build the path.

The doc holds: the questions, the input inventory, the insights with sources and confidence grades, the weak-signals list, the conflicts, the answers per question, the next research move.
