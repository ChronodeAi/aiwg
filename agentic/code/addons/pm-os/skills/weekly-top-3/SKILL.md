---
name: weekly-top-3
description: >-
  Use when the week ahead is a pile of meetings, threads, and half-started projects and you need to triage it into the 3 priorities that define success — plus protected time to do them and a decision on what deliberately doesn't happen. Not for reviewing what you accomplished (`top-5-wins`), writing the weekly report (`status-update`), or roadmap horizons (`now-next-later`).
---

# Triage the week to three priorities

## Step 1 — Dump everything on the plate

Ask for the full pile: meetings scheduled, projects in flight, urgent items from Friday onward, decisions pending, follow-ups owed, and what rolled over from last week. Also get the quarter's top goals and any constraints (out-of-office, energy level).

Done when the dump is in front of you and the quarter goals are stated — priorities get judged against goals, not against noise.

## Step 2 — Triage the pile

Sort every item: do this week (deadline, blocker for others, escalation), schedule this week (strategic work that never becomes urgent until too late), delegate or quick-hit (someone else's urgency), and drop. Tie each "do" to a quarter goal or a named forcing event.

Done when every item from the dump is in exactly one bucket with its reason.

## Step 3 — Commit to the three

From the "do" bucket, pick the 3 priorities by the rule: *if only these got done, the week was a success.* Three, not five. If a fourth feels mandatory, it displaces one — say which and why.

Done when there are exactly 3, each passing the success rule, and the displaced near-misses are listed with where they went.

## Step 4 — Protect the time

Check the calendar against the three: estimate hours each priority needs, find the deep-work blocks that cover them, and name the meetings to decline, delegate, or make async to create the room. A priority with no calendar time is a wish.

Done when each priority has named blocks on real days totaling its estimate, and freed-up meetings are listed.

## Step 5 — Decide what doesn't happen

Write the no-list: the requests and tasks this week's triage rejects, with the one-line deferral script for each ("Focused on X this week — can this wait until {date}?"). Then the contingency: if a fire eats a day, which priority survives and what slides first.

Done when the no-list is explicit and the contingency names what's protected and what slides.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-weekly-top-3.md`. Never hand-build the path.

The plan holds: the 3 priorities with their success rule, the triage buckets, the protected blocks and freed meetings, the no-list with scripts, and the contingency.
