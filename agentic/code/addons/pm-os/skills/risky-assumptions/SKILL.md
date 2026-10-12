---
name: risky-assumptions
description: >-
  Use when a list of assumptions needs ranking and a 1–5 scoring rubric would
  just produce ties — *pairwise* comparisons under QuickSort force one pick per
  pair, ending in a full order and the top 1–3 to test first. Also `/assumptions`
  Step 2. Not for generating the assumptions being ranked (`product-assumptions`),
  finding the cheapest signal that settles one (`work-backwards`), or ranking
  discovery opportunities rather than risks (`ost-prioritize`).
---

# Rank assumptions by risk through pairwise comparison

## Step 1 — Parse the assumptions

Take the assumption list and extract each item's statement ("We believe that…"), its impact if wrong, and its lens (Desirability, Feasibility, Viability, Usability). If the list arrives without impact lines, ask for them — the comparison is unreliable without the consequence.

Done when every assumption is numbered and carries a statement, an impact, and a lens.

## Step 2 — Rank by pairwise QuickSort

Sort the list with QuickSort, resolving each comparison by asking the user rather than scoring. Pick a pivot (start at the middle item), compare every other assumption against it, split into more-risky and less-risky, then recurse into each half.

Put every comparison to the user through the host's structured input surface when available, or one concise conversational question otherwise — one question, two options, no ties. Render each option as:

```
[Lens] We believe that [statement]

Impact if wrong: [impact text]
```

The riskier assumption is the one that wins on:

1. **Severity** — which failure hurts more.
2. **Uncertainty** — which one you are less sure about.
3. **Irreversibility** — which mistake is harder to recover from.

After each pivot resolves, report the running count: how many comparisons that pivot took, how many landed more risky and less risky, and the total so far. If the user's picks form a cycle (A over B, B over C, C over A), name the cycle, re-ask the conflicting pair, and take the later answer.

Done when every assumption holds one position in a single order, no pair is left unresolved, and no cycle survives.

## Step 3 — Report the order and the top 1–3

Output the ranked list highest risk first, each line carrying lens, statement, and impact. Then the comparison count against the ~N log N expectation, the top 1–3 to test first, and any ranking that came out differently from what the list's original order implied.

Done when the order is complete, the top 1–3 are named, and every rank that inverted against the input order is called out with one line on why.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-risky-assumptions-{product-slug}.md`. Never hand-build the path.

The doc holds: the ranked list, the comparison count, the top 1–3 to test first, and the surprises.
