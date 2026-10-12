---
name: feedback-loop
description: >-
  Use when a PM wants a post-launch learning plan — *checkpoints* after launch, what each one measures, who reviews it, and how findings reach the next iteration's plan. Also fires on "we launched X and never learned anything from it." Not for defining the success metric itself (`success-metric`), designing an experiment (`experiment-design`), or NPS programs (`nps-to-cx-plan`).
---

# Plan the post-launch feedback loop

## Step 1 — Get the launch facts

Ask, in one question, for: what launched (or launches) and when; which data sources exist today — analytics, support tickets, sales notes, session recordings, whatever is real; and who is available to review findings.

Done when all three are answered and the data-source list contains only sources that exist now, not ones the team wishes it had.

## Step 2 — Trace where feedback currently dies

For each existing source, trace its path: who sees it, and what the last thing was that changed because of it. A source nobody has acted on in a quarter is a dead end — name it as one.

Done when every source is marked either "reaches a decision" or "dies at {point}," each with a one-line example.

## Step 3 — Set the checkpoints

Pick 3 checkpoints scaled to the launch — for most launches: week 1 (is it broken?), month 1 (is it being adopted?), month 3 (did it work?). For each, name the one decision it exists to make and the 3–5 signals that inform it, drawn only from Step 1 sources. A signal with no source gets an owner and a build date or gets cut.

Done when every checkpoint has one decision and every signal either exists today or has a named owner and date.

## Step 4 — Assign the mechanics

For each checkpoint: who owns it, what form the review takes (meeting or async doc), and where the decision gets recorded. An unowned checkpoint will not happen — push until each has a name or a role that maps to one person.

Done when every checkpoint has an owner, a format, and a recording location.

## Step 5 — Wire findings into the next iteration

Name the existing ritual where each checkpoint's decision enters planning — sprint planning for week-1 fixes, roadmap review for month-3 verdicts. Add one escalation rule: what finding severity skips the queue and goes straight to whom. If the team has no such ritual, the loop's output has nowhere to land — flag that as the first thing to fix.

Done when each checkpoint's decision has a named, already-scheduled ritual it feeds, and the escalation rule names a threshold and a person.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-feedback-loop-{launch-slug}.md`. Never hand-build the path.

The doc holds: the launch facts, the source trace with dead ends, the checkpoint table (date, decision, signals, owner, format, record), the planning entry points, the escalation rule.
