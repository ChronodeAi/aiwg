---
name: exec-feedback
description: >-
  Use when an executive drops context-light feedback on existing work — "this feels cluttered," "not strategic enough," "something's off" — and the PM must act without a follow-up meeting on the calendar. Produces competing *interpretations*, a send-ready clarifying message, and a no-regret interim step. Not for a vague incoming brief (`brief-to-problem`) or preparing for the exec meeting itself (`prep-the-room`).
---

# Act on context-light exec feedback

## Step 1 — Capture the moment

Get the feedback verbatim, who said it, in what setting (review, hallway, Slack), and exactly what they were looking at when they said it. The artifact matters: "cluttered" about a dashboard and "cluttered" about a strategy doc are different sentences.

Done when the quote, the person, the setting, and the artifact are all captured.

## Step 2 — Classify it

Two calls: is this a **requirement** (blocks approval until addressed) or a **preference** (worth weighing, not binding)? And what is it about — strategy, quality, risk, or user impact? If the user can't tell requirement from preference, that becomes the first clarifying question, not a guess.

Done when both calls are made with a one-line reason each, or the requirement/preference call is explicitly deferred to Step 4.

## Step 3 — Write the competing interpretations

Write 2–3 interpretations of what the exec meant. Each must pass one test: it implies *different work* than the others — different screens touched, different scope, different owner. Interpretations that differ only in wording are one interpretation. For each: what "addressed" looks like as a checkable condition, rough effort, and likelihood given the setting and the exec's history.

Done when there are 2–3 interpretations, each implying visibly different work, each with a done-condition, effort, and likelihood.

## Step 4 — Draft the clarifying message

Write the actual message to send — not advice about messaging. Structure: acknowledge the feedback, show the interpretations in one line each, ask the single question whose answer separates them. Short enough to answer from a phone.

Done when the message is send-ready, contains one question, and a busy exec could answer it in one line.

## Step 5 — Name the no-regret interim step

Find the work that is correct under every interpretation from Step 3 — often the highest-likelihood interpretation's cheapest slice, or the data that would inform all of them. If no such work exists, say so; waiting is then the right move, and the message from Step 4 gets urgency instead.

Done when the interim step is valid under all interpretations, or "wait" is stated with the reason.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-exec-feedback-{topic-slug}.md`. Never hand-build the path.

The doc holds: the verbatim moment, the classification, the interpretations table, the clarifying message, the interim step.
