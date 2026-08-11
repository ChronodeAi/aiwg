---
name: top-5-wins
description: >-
  Use when you need to distill a stretch of completed work — todo list, calendar, shipped items — into the top 5 wins stated as outcomes, for a brag doc, perf review input, or end-of-week reflection. Not for planning the coming week (`weekly-top-3`), the weekly report to others (`status-update`), or interview-ready narratives (`star-stories`).
---

# Distill the work into five outcomes

## Step 1 — Collect the evidence

Ask for the raw record of the period: completed todos, the calendar (paste or screenshot), shipped work, decisions made. Fix the time window — a week, a quarter, since the last review.

Done when the record and the window are both in hand.

## Step 2 — Extract the candidates

Pull every completed item that could count as a win. Weigh each by: impact on the product or business, difficulty, cross-team collaboration, and creativity. Meetings only count through what they produced — a decision, an unblock, an alignment.

Done when the candidate list is exhaustive over the record and each carries a rough impact note.

## Step 3 — Convert activities to outcomes

Rewrite each candidate as its outcome: "ran 6 checkout interviews" becomes "found the drop-off cause blocking checkout redesign." If an item resists conversion — no outcome to name — it's activity, not achievement; cut it. Don't inflate: claim only what the record supports, with numbers where they exist.

Done when every surviving candidate names a change in the world, and none claims more than the evidence shows.

## Step 4 — Pick the five

Rank by impact and keep the top 5. Prefer a mix the audience cares about — shipped work, decisions unblocked, relationships built — over five of the same kind. For each, one or two sentences: the outcome, and just enough context to convey why it mattered.

Done when there are exactly 5, ordered by impact, each self-explanatory to someone who wasn't there.

## Step 5 — Point at the gap

One line of reflection: what the list says about where the effort went, and whether anything important got no wins this period — that gap is next period's priority candidate.

Done when the gap (or its absence) is named in one line.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-top-5-wins.md`. Never hand-build the path.

The doc holds: the window, the 5 wins as outcomes with impact notes, and the gap line.
