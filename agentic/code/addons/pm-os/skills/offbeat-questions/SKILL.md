---
name: offbeat-questions
description: >-
  Use when a topic needs playful, absurd, or humorous questions to loosen
  rigid thinking before serious ideation — unexpected comparisons and
  playful twists, not high-leverage strategic questions. Not for serious,
  high-leverage strategic questions (`good-question-brainstormer`), or
  provocation-based problem reframing (`lateral-thinking`).
---

# Loosen the frame with a genuinely playful question

## Step 1 — Take the topic

Get the topic to generate questions about.

Done when the topic is specific enough to play with.

## Step 2 — Generate offbeat "why" questions

Write at least 3 "why" questions that use unexpected comparisons, absurd scenarios, or playful twists on the topic — not questions with an obvious serious answer.

Done when at least 3 "why" questions are written, none answerable with a straightforward factual response.

## Step 3 — Generate other offbeat formats

Write at least 2 more offbeat questions in other formats — "what if," "how come," or any playful angle that doesn't fit the "why" pattern.

Done when at least 2 additional questions are written in a format distinct from Step 2's.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-offbeat-questions-{topic-slug}.md`. Never hand-build the path — save is optional for a one-off warm-up exercise.

The doc holds: the offbeat "why" questions and the other offbeat questions, grouped separately.
