---
name: metaphor-thinking
description: >-
  Use when you're stuck in a stale frame on a problem and want a fresh angle by borrowing structure from an unrelated domain — a *metaphor* that transfers a mechanism, not a mood, into concrete moves the literal frame missed. Not for reframing the problem statement directly (`lateral-thinking`), generating idea volume on a topic (`brainstorm-genius`), or structured analysis toward a recommendation (`structure-problem`).
---

# Find fresh moves through metaphorical thinking

## Step 1 — State the problem and what's stuck

Write the problem in one plain sentence, then name what specifically feels stuck about the current frame — the assumption everyone's making, the option that keeps looping, the trade-off that won't resolve.

Done when the problem is one sentence and the stuck point is named, not just "we're stuck."

## Step 2 — Generate metaphors from distant domains

Produce 5–6 metaphors from deliberately unrelated domains — nature, warfare, cooking, medicine, sport, cities, ecosystems. For each, name the **structural parallel**: the mechanism in that domain that matches the shape of your problem, not a surface resemblance.

Done when there are 5–6 metaphors from genuinely different domains, each naming a structural parallel rather than a vibe.

## Step 3 — Transfer the mechanism

For the 2–3 strongest, spell out how the source domain actually handles the problem — the specific move, defense, or design — then ask what the equivalent move is in your situation.

Done when each strong metaphor has its source-domain mechanism stated and a candidate move translated back to the real problem.

## Step 4 — Extract concrete moves

List 3–5 concrete moves the metaphors surfaced that the literal frame didn't — each a thing you could actually try, not a restatement of the metaphor.

Done when there are 3–5 concrete moves, each phrased as an action rather than an analogy.

## Step 5 — Filter for what survives

Mark which moves are real options versus artifacts of the metaphor that break on contact with the actual constraints. A metaphor is a lens, not a proof — keep what holds up when the metaphor is dropped.

Done when every move is marked real-option or metaphor-artifact, with one line on why.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-metaphor-thinking-{problem-slug}.md`. Never hand-build the path.

The doc holds: the problem and its stuck frame, the metaphors with their structural parallels, the transferred mechanisms, the concrete moves, and the filtered shortlist of what survives.
