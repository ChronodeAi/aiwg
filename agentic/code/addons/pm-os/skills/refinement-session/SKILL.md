---
name: refinement-session
description: >-
  Use when preparing for or running a product refinement session — a
  timeboxed agenda, discussion questions, and a closing statement built
  around understanding the problem deeply, not estimating the solution.
  Not for turning a raw task list into a sequence (`task-sequence`), or a
  general meeting prep brief (`meeting-prep`).
---

# Refine understanding, not estimates

## Step 1 — Take the session topic

Get the specific item or items up for refinement.

Done when the session topic is specific enough to build an agenda around.

## Step 2 — Build the timeboxed agenda

Structure the session: context setting (why this matters now), problem space exploration (core problem, stakeholders, dependencies, constraints, assumptions), success criteria definition (what success looks like, how it's measured, acceptance criteria), and a closing retrospective slot. Assign a time box to each section.

Done when every section has a time box and covers its stated purpose, not just a generic meeting outline.

## Step 3 — Generate discussion questions

Write 3-5 questions specific to this session topic that would drive the problem-space exploration section — not generic refinement questions that could apply to any topic.

Done when every question references a specific aspect of this topic, not a template question.

## Step 4 — Write the closing statement

Draft a 2-3 sentence close that reinforces why the refinement mattered and names the next step.

Done when the closing statement names a specific next step, not a generic thank-you.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-refinement-session-{topic-slug}.md`. Never hand-build the path.

The doc holds: the timeboxed agenda, the discussion questions, and the closing statement.
