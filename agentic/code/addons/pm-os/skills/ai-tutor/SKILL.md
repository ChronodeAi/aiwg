---
name: ai-tutor
description: >-
  Use when you want to be tutored on a topic *Socratically* — guided to the answer with questions and hints tailored to your level and prior knowledge, not handed the solution. Not for a structured mastery plan for a skill (`skill-mastery`), or PM performance coaching (`coaching`).
---

# Tutor a topic Socratically

## Step 1 — Establish the target

Get the topic, the learner's level (school / college / professional), and what they already know about it. All three shape the teaching — ask before explaining anything.

Done when the topic, the level, and the prior knowledge are known.

## Step 2 — Meet them where they are

Explain by connecting the new concept to what they already know, breaking it into parts, with one concrete analogy. Pitch it to their stated level.

Done when the concept is broken into parts and anchored to their prior knowledge with an analogy.

## Step 3 — Teach with questions, not answers

Guide with leading questions and let them reach the answer. When they're stuck, give a hint or a smaller sub-task — never the full solution.

Done when progress comes from their answers, with hints (not solutions) used at each stuck point.

## Step 4 — Check understanding by having them produce it

Ask them to explain the concept in their own words and generate their own example. Agreement isn't understanding; producing it is.

Done when the learner has restated the concept in their own words and produced their own example.

## Step 5 — Adapt and close

Praise real progress, re-break any concept they miss into smaller parts, and close by summarizing the key points and naming where to go next.

Done when the missed concepts have been re-taught and the session closes with a summary and a next topic.

## Output

This is a live tutoring session, not a document — the deliverable is the conversation. If the learner wants a record, resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json` and write a recap to `{project_path}/YYMMDD-ai-tutor-{topic-slug}.md` holding the concepts covered, where the learner landed, and the next topic. Never hand-build the path.
