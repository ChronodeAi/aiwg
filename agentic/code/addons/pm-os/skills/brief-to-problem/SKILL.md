---
name: brief-to-problem
description: >-
  Use when a stakeholder hands over a vague *brief* — "make it modern," "improve the UX," "simplify this" — and the PM needs a concrete problem statement with a metric before any design work starts. Not for interpreting exec feedback on existing work (`exec-feedback`), framing from a session transcript (`problem-framing-canvas`), or pulling a team out of solution mode (`problem-first`).
---

# Turn a vague brief into a problem statement

## Step 1 — Capture the brief verbatim

Get the brief word for word, who gave it, and any current metrics that exist for the area it touches. The exact wording matters — "modern" and "fresh" decode differently.

Done when the brief is quoted, the requester is named, and metrics are attached or marked none.

## Step 2 — Decode the vague words

For each subjective term in the brief, list 2–3 concrete things it could mean *for this product* — "modern" might mean load time, visual refresh, or mobile-first; "simpler" might mean fewer steps or fewer choices. Flag anything that is a solution wearing a problem's clothes ("we need a chatbot") and restate it as the outcome it's presumably after.

Done when every subjective term has candidate concrete meanings and every smuggled solution is restated as an outcome.

## Step 3 — Find the trigger

Something made the requester say this *now* — a competitor launch, an exec comment, a lost deal, a metric dip, a board meeting. Ask; don't guess. The trigger usually picks which decoded meaning from Step 2 is the real one.

Done when the trigger is a specific event, or explicitly unknown with the question that would surface it.

## Step 4 — Draft the problem statement

Fill the frame: *We need to [change] for [user segment] so that [user outcome] and [business outcome], measured by [metric] moving from [baseline] to [target] by [date].* Add one line each of in-scope and out-of-scope. Fill every bracket with a real value or mark it TBD — a TBD is honest; an invented baseline is not.

Done when every bracket holds a real value or a TBD, and scope has an explicit out line.

## Step 5 — Write the questions that close the TBDs

For each TBD and each interpretation still live from Step 2, write the one question to the requester that settles it. Five questions maximum — more than that means Step 2 or 3 was skipped.

Done when every question maps to a specific TBD or a live interpretation, and there are at most five.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-brief-to-problem-{brief-slug}.md`. Never hand-build the path.

The doc holds: the verbatim brief and requester, the decoded terms, the trigger, the problem statement with its TBDs, the scope lines, the questions.
