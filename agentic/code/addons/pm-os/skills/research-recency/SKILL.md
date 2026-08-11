---
name: research-recency
description: >-
  Use when a PM is about to reuse old research and needs to know what has *decayed* — "we did interviews 18 months ago, can we still trust them?", pre-kickoff checks on an old study, or challenges to a decision resting on aging findings. Not for synthesizing research (`research-synthesis`) or planning new research from a hunch (`intuition-to-research`).
---

# Check old research for decay

## Step 1 — Get the findings and what changed

Ask for: the research findings (one per line, or the doc to extract them from), when the research was done, and what has changed since — in the product, the market, the user base, the competition. If the user doesn't know what changed, list the candidate changes from context and confirm.

Done when the findings are listed one per line with the research date, and the changes-since list is confirmed or marked unknown.

## Step 2 — Sort findings by decay speed

Type each finding: **slow-decay** (need, job-to-be-done, motivation) or **fast-decay** (behavior, pain point, preference, workflow, tool choice). When a finding mixes both — "users need X and do it via Y" — split it.

Done when every finding carries a type and no finding mixes the two.

## Step 3 — Check each finding against the changes

For each finding, ask: did any specific change from Step 1 plausibly invalidate it? Verdicts: **still valid** (no change touches it), **validate first** (a named change could have broken it), **assume stale** (a named change almost certainly broke it — e.g., the pain point was since shipped a fix, the workflow's tool was replaced). The reason must name the change, not just the age — "it's old" is not a verdict.

Done when every finding has a verdict whose reason names a specific change or its absence.

## Step 4 — Turn "validate first" findings into cheap checks

Rewrite each validate-first finding as a testable statement, and pair it with the lightest check that would settle it: an analytics query, a 5-question survey, three customer calls, a support-ticket search. Prefer checks the team can run this week.

Done when every validate-first finding has one named check and roughly what it costs.

## Step 5 — Deliver the use-today verdict

Three buckets: **use as fact** (still valid), **use as hypothesis** (validate first — usable now, but labeled), **don't use** (assume stale, with the fresh research needed to replace it). Frame it as building on the old work, not discarding it — the stale findings earned their replacement questions.

Done when every finding from Step 1 lands in exactly one bucket and the don't-use bucket names its replacement research.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-research-recency-{study-slug}.md`. Never hand-build the path.

The doc holds: the findings with dates, the changes-since list, the per-finding verdicts with reasons, the validation checks, the three buckets.
