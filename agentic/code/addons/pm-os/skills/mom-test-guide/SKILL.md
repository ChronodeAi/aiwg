---
name: mom-test-guide
description: >-
  Use when you're about to run a real customer interview and need the
  discussion guide written first — grounded in *The Mom Test* discipline
  (past behavior over hypotheticals, no pitching, no leading questions) and
  Teresa Torres' *Continuous Discovery Habits*. Not for a simulated practice
  transcript (`jtbd-transcript-sim`), or analyzing a transcript once it
  exists (`interview-insights`).
---

# Write a Mom-Test interview guide

## Step 1 — State the topic and the decision it feeds

Name the topic and the product or feature decision this research is meant to inform. A guide with no decision behind it drifts into generic curiosity.

Done when the topic and the decision it feeds are both named.

## Step 2 — Write questions that pass the Mom Test

Every question asks about a specific past instance, not hypothetical future behavior or opinion — "talk me through the last time you tried to do X" beats "would you use a tool that does X." No leading questions, no pitching the idea, no fishing for compliments.

Done when every question asks about a specific past instance, and none names or hints at the solution being considered.

## Step 3 — Sequence the guide

Order: warm-up, current workflow, pain points and workarounds, desired outcomes, hesitations, wrap-up. Put each section's most important question first — the interview may end early.

Done when all six sections are present in order and each section leads with its most important question.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-mom-test-guide-{topic-slug}.md`. Never hand-build the path.

The doc holds: the topic, the decision it feeds, and the sequenced question guide.
