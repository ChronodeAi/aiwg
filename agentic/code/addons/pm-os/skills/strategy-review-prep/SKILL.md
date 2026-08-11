---
name: strategy-review-prep
description: >-
  Use when a draft strategy document needs sharpening before a review —
  strengths and gaps named, specific copy/structure improvements written
  in the draft's own voice, and the top 3 questions the room will
  actually ask. Not for stress-testing an investment case's assumptions
  (`exec-deck`), or planning a deck before any slides exist
  (`strategic-deck`).
---

# Sharpen the draft, don't just critique it

## Step 1 — Take the draft and context

Get the draft strategy document and the surrounding context (audience, stakes, what's already been decided).

Done when the draft and its context are both in hand.

## Step 2 — Analyze strengths and gaps

Check the draft for: a compelling punchline, front-loaded controversial elements, a memorable stat or insight, clearly stated customer pain points tied to the proposed solution, explicit assumptions and trade-offs, and proactive framing of likely executive questions. Name what's already strong and what's missing for each.

Done when every element on the list has a stated strength or a named gap, not a generic pass/fail.

## Step 3 — Write specific improvements

For each gap found, write the actual replacement text — in the draft's own voice and style, not a description of what should change. Up to 10 improvements. Never fabricate a data point or claim not already present in the draft or context; if a claim needs data the draft doesn't have, name that gap explicitly instead of inventing a number.

Done when every gap from Step 2 has either a drafted replacement or an explicit note that it needs data not yet available.

## Step 4 — Name the top 3 discussion points

Identify the 3 points most likely to become the review's actual focus — the ones a sharp exec would push on hardest.

Done when exactly 3 discussion points are named, each grounded in a specific element of the draft, not a generic "questions may arise."

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-strategy-review-prep-{doc-slug}.md`. Never hand-build the path.

The doc holds: the strength/gap analysis, the specific improvements, and the top 3 discussion points.
