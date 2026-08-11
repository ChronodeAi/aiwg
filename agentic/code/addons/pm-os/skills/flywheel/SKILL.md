---
name: flywheel
description: >-
  Use when a company's successes and disappointments need distilling into a Jim Collins-style *flywheel* — 4–6 components in a self-reinforcing loop that explains why the wins won and the losses lost. Fires on "what's our flywheel" or "why do some bets work for us and others don't." Not for the growth model and its constraint (`growth-strategy`), sequencing items into a loop (`reinforcing-sequence`), or durable moats (`moats`).
---

# Distill the company flywheel

## Step 1 — Collect the evidence

Ask for: the company basics, the significant *replicable* successes (wins that happened more than once or clearly could), and the significant disappointments. Push for specifics — "the enterprise tier took off" beats "we grew." One-off luck gets marked as such; the flywheel is built from what repeats.

Done when there are at least 3 successes and 2 disappointments, each concrete enough to test a flywheel against.

## Step 2 — Find the pattern between wins and losses

Compare the successes to the disappointments: what do the wins share that the losses lack? Look for the causal texture — what preceded each win, what was missing or violated in each loss. Write the candidate factors down before assembling anything; assembly before analysis produces the loop you wanted rather than the one that's there.

Done when the shared factors of the wins are listed, and each disappointment is annotated with which factor it lacked.

## Step 3 — Assemble the loop

Pick 4–6 components from the factors and arrange them so each causes the next, with the last feeding the first — every arrow must survive the question "does more of this actually produce more of that, here?" More than 6 components means consolidation is owed; a broken arrow means the sequence is wrong or a component is decoration.

Done when the loop has 4–6 components and every arrow holds under the more-of-this test.

## Step 4 — Test the loop against the evidence

Run every Step 1 item through the flywheel. Each success should map to the loop turning; each disappointment should map to a component skipped, starved, or violated. Count the fits honestly — a flywheel that explains 8 of 10 is strong; one that needs excuses for half the record goes back to Step 3.

Done when every success and disappointment has a verdict — explained or not — and unexplained items are visible, not massaged.

## Step 5 — Check it against the Hedgehog and name the flywheel's fuel

Check the loop against Collins's three circles: does it run on what the company can be best at, what drives its economic engine, and what its people care about? A flywheel outside any circle will stall. Then name the fuel — the one input that, added consistently, spins the loop faster — because that's what the exercise was for.

Done when each circle has a yes-with-reason or a flagged gap, and the fuel is one named input.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-flywheel-{company-slug}.md`. Never hand-build the path.

The doc holds: the evidence lists, the win/loss factors, the loop with its arrows, the test results including unexplained items, the Hedgehog check, the fuel.
