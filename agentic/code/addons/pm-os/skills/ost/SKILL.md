---
name: ost
description: >-
  Use when interview material needs structuring into a Teresa Torres Opportunity Solution Tree — opportunities extracted quote by quote, assigned to *moments in time*, deduplicated, and checked with the sibling-distinctness and parent-child tests. Also `/opportunity` Step 2. Not for eliciting the inputs first (`ost-intake`), selecting one target from the finished tree (`ost-prioritize`), or MECE-checking a flat list of siblings (`mece-tree`).
---

# Build the Opportunity Solution Tree

An **opportunity** is a customer need, pain, or desire, phrased from the end user's perspective. Solutions are not opportunities — every solution-shaped item found in the interviews gets reframed into the need beneath it ("phone settings broken" → "I can't review all my calendars at once"). The tree that comes out holds opportunities only.

Two tests govern the structure:

- **Distinctness (sibling–sibling):** if one sibling can be pursued without addressing the other, they are distinct. Otherwise combine or reframe.
- **Parent–child:** solving the child must *partially solve* the parent. If it does not, reframe.

## Step 1 — Take the four inputs

`business_outcome`, `journey_nodes_as_list` (the moments in time), `interview_transcripts_or_story_snippets` with speaker labels and timestamps, and optional `constraints_or_principles`. Run `ost-intake` if any are missing or solution-flavoured.

Done when all four are present and the outcome names no solution.

## Step 2 — Extract opportunities quote by quote

Pull each opportunity from the interview material with its supporting quote. Keep the user's original phrasing *and* write a reframed user-need statement alongside it. Flag anything that arrived as a solution and reframe it.

Done when every extracted opportunity holds both its verbatim phrasing and its reframed need statement, with quotes attached.

## Step 3 — Assign each to one moment

Every opportunity goes to exactly one moment from `journey_nodes_as_list` — its primary moment. Where it genuinely spans several, record the others in `alt_moments`. Where placement is uncertain, note the ambiguity and your reasoning rather than picking silently.

Done when every opportunity has one primary moment, and each ambiguous placement carries its rationale.

## Step 4 — Group, structure, and prune within each moment

Cluster similar opportunities. Create or validate parent nodes where a sibling set has no clear parent. Run the distinctness test across siblings and the parent–child test down each branch. Delete a generic parent that has only one specific child — keep the child. Collapse near-duplicates into the clearest evidence-backed phrasing, recording `duplicates_of` so the trail survives.

Prefer specific opportunities where quotes support them; keep a general version only when it has multiple specific children.

Done when every branch passes both tests and no generic parent holds a single child.

## Step 5 — Record evidence, gaps, and a lightweight priority

Per opportunity: representative quotes, mention count, and confidence (low/med/high). Identify missing siblings, but include only what was *heard* — log hypothesised siblings separately so they never enter the tree as evidence. Suggest a priority from `impact × frequency × alignment_to_business_outcome`, each 1–5 with a rationale; treat it as a sorting aid, not a decision.

Done when every opportunity carries quotes, a frequency count, and a confidence level, and hypotheses sit outside the tree.

## Output

**Part A — Opportunity inventory**, a markdown table of all leaf and parent opportunities:

| id | moment | opportunity_reframed | parent_id | duplicates_of | representative_quotes | frequency_count | confidence | alt_moments | reframe_rationale |
| -- | ------ | -------------------- | --------- | ------------- | --------------------- | --------------: | ---------- | ----------- | ----------------- |

`id` is a short stable handle (`A1`, `R3`); `duplicates_of` is blank unless collapsed.

**Part B — Structured OST**, strict JSON:

```json
{
  "business_outcome": "<one sentence>",
  "moments": [
    {
      "moment": "<journey node>",
      "tree": [
        { "id": "A1", "type": "opportunity", "title": "<reframed need>",
          "children": [ { "id": "A2", "type": "opportunity", "title": "...", "children": [] } ] }
      ]
    }
  ],
  "traceability": {
    "A1": { "quotes": ["..."], "frequency_count": 4, "confidence": "high",
            "alt_moments": [], "duplicates_of": null, "priority": {"impact": 4, "frequency": 5, "alignment": 3} }
  },
  "hypothesized_siblings": [ { "moment": "<node>", "title": "<need>", "why": "..." } ]
}
```

Inside `/opportunity`, hand Part B to `ost-prioritize` as Step 3's input.
