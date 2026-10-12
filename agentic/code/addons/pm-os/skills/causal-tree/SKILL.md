---
name: causal-tree
description: >-
  Use when a decision needs its root cause traced backward and each candidate
  option's downstream consequences traced forward, one branch at a time —
  recursive "why" until you hit bedrock, then forward from the live options to
  what each one actually causes. Also /decisions Step 1, producing the causal
  map and consequence tree the rest of the workflow builds on. Not for
  checking whether a list of options is MECE (`mece-tree`), the full Why-tree
  pipeline with testable hypotheses (`mckinsey-issue-tree`), or converging a
  messy problem to one recommendation (`structure-problem`).
---

# Trace root causes backward, consequences forward

A decision usually arrives with a symptom, not a cause, and a shortlist of options nobody has stress-tested. This skill does both halves: walk backward from the symptom to what's actually driving it, then walk forward from each option to what it would actually cause.

Inside `/decisions` this is Step 1: standalone, gather the decision or presenting problem and whatever options are already on the table.

## Step 1 — Fix the question and the options on the table

State the presenting problem as one question. Name every option already under consideration; if none exist yet, say so explicitly — Step 3 will trace the situation as a whole instead of per-option.

Done when the question is one sentence and the options are either listed or their absence is noted.

## Step 2 — Trace root causes backward

Ask "why" of the question, then "why" again of that answer, continuing until you hit a cause you can't ask why of again, or you run out of evidence. Where more than one plausible cause exists at a level, branch — don't force a single line through a fork.

Done when the backward chain reaches bedrock (nothing further to ask) or every open branch has an explicit evidence gap named, not glossed over.

## Step 3 — Trace consequences forward, per option

For each option on the table (or the situation as a whole, per Step 1), trace first-, second-, and third-order consequences — what it fixes and what it breaks. Stop deepening a branch once it turns speculative rather than inventing a fourth order.

Done when every option has consequences traced at least two orders deep, with the speculative stop point marked.

## Step 4 — Flag what would kill the leading cause

Name the leading candidate root cause from Step 2 and the one piece of observable, checkable evidence that would rule it out. A root-cause map nothing could falsify is a story, not an analysis.

Done when the leading cause is named and one falsifying fact is stated.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-causal-tree-{question-slug}.md`. Never hand-build the path.

The doc holds: the question, the backward causal chain with branches and evidence gaps, the forward consequence tree per option, and the falsifying fact for the leading cause.
