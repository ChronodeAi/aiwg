---
name: pm-os-skill
description: >-
  Use when the user wants to find the right PM skill for a task, browse
  skills by topic, or says '/skill'. Not for finding a framework
  (`pm-os-framework`), a full system tour (`pm-help`), or browsing every
  skill visually (`skill-browser`).
---

# /skill [task] — Match

## When to use

Type `/skill` followed by what you are trying to do. Examples:

- `/skill write a decision journal`
- `/skill map stakeholder power dynamics`
- `/skill turn interview transcripts into JTBD insights`
- `/skill build a feature impact model`

## How it runs

1. Match the task description against skill folder names and trigger descriptions in `skills/`
2. Delegate to `agents/knowledge-librarian.md` for matching
3. Present top 3–5 skill matches: name + trigger description + when to use
4. Ask which to invoke
5. When the user picks: read that skill's `SKILL.md` and follow it exactly

Done when the user has picked one match and its `SKILL.md` is being followed.

## Note on skill-first vs workflow-first

If the task maps to one of the 10 PM workflows (`/strategy`, `/opportunity`, `/assumptions`, `/research`, `/decisions`, `/stakeholder`, `/meeting`, `/review`, `/coaching`, `/measure`), suggest the workflow instead — it chains multiple skills in sequence for deeper, end-to-end results.

Use `/skill` for standalone, single-task invocations where you want one specific tool without the full workflow sequence.
