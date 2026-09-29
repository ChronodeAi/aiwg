---
name: ost-prioritize
description: >-
  Use when a mapped opportunity space needs narrowing to one target to explore next — Teresa Torres's four factors applied as *compare-and-contrast* reasoning, never a weighted score, from a tree, a flat list, or an OST JSON. Also `/opportunity` Step 3. Not for building the tree first (`ost`), force-ranking a requirements list into P0/P1/P2 (`p0-p1-p2`), or placing one request on a priority×effort 2×2 (`tradeoff-matrix`).
---

# Prioritize the opportunity space

Choosing which opportunity to address is where product strategy actually happens — most teams skip it and argue about features instead, which is why they never make directional bets. Torres's five ground rules govern the whole session:

1. **This is reversible.** You are committing to *exploring* an opportunity, not permanently solving it. Move with confidence; if it turns out wrong, pick another.
2. **No made-up math.** These judgements are subjective. A weighted formula manufactures false precision and anchors the team on estimates as if they were facts.
3. **Compare and contrast, never whether-or-not.** Not "should we address this?" — "which of these is most important to address right now?"
4. **No effort estimates.** Feasibility belongs to solution exploration; bringing it in here distorts the opportunity assessment.
5. **A crummy first draft is enough.** Do not wait for perfect data. Revisit every 3–4 interviews.

## Step 1 — Confirm the space is comparable

Take the opportunity space (an `ost` JSON, a tree, or a flat list), the business outcome, the customer evidence, and any company context — strategy, mission, constraints. From an OST JSON, harvest the leaf opportunities plus any intermediate parent with two or more specific children or a `traceability` entry of its own.

Need at least 2–3 candidates at the same level of the tree; without siblings there is nothing to compare. Verify each is framed as a need, pain, or desire, and reframe anything solution-flavoured ("add notifications") into the need beneath it.

Done when 2–3+ same-level candidates exist, each framed as a customer need.

## Step 2 — Attach the evidence

For each candidate, pull the relevant quotes and data points: how many customers raised it, how recently, and with what emotional weight. Thin evidence gets flagged low-confidence and the candidate stays in — do not stall on it.

Done when every candidate carries its evidence and a confidence flag.

## Step 3 — Reason through the four factors

| Factor | Question |
|---|---|
| Opportunity sizing | How many customers are affected, and how often? |
| Market factors | How would addressing this move our position — does it answer a competitive threat or open a new one? |
| Company factors | How well does this fit the mission, vision, and current objectives? Does it play to strengths or weaknesses? |
| Customer factors | How important is this to customers, and how satisfied are they today? Low satisfaction plus high importance is the strong signal. |

Walk each factor for each candidate in plain language. Where a factor lacks data, assume neutral and name the gap. Produce no score.

Done when every candidate has plain-language reasoning on all four factors, with the data gaps named.

## Step 4 — Compare side by side

Put the candidates against each other: "compared to [A], [B] is stronger on [factor] because [evidence], but weaker on [factor] because [reason]." Break ties in order: **distinctness** (thinnest, most independent slice wins), then **evidence quality**, then **time-to-learning** (which can be tested fastest).

Done when the trade-offs are stated as a narrative, not a matrix, and any tie is broken on a named rule.

## Step 5 — Name one target

State the top candidate and the reasoning. Confirm it is small, moment-scoped, and addressable independently of its siblings. Say what the next 3–4 customer interviews would need to show to validate or invalidate the choice.

Done when one target is selected, its independence confirmed, and the invalidating evidence named.

## Output

Five sections: (1) candidates with evidence and confidence; (2) four-factor reasoning per candidate; (3) the compare-and-contrast narrative; (4) the recommendation — selected opportunity, 3–5 "why now" bullets, distinctness check, key unknowns, next steps; (5) the anti-pattern check.

The anti-patterns, confirmed avoided in section 5: spreadsheet scoring (RICE, effort/impact matrices) that treats subjective estimates as objective truth; "should we fix this?" binary framing; effort smuggled into the assessment; waiting for perfect data; comparing a single candidate against nothing; keeping generic parents when specific children exist.

Next step after this: generate three competing solution ideas for the target, then map the assumptions behind them (`assumptions`).

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-target-opportunity.md`. Never hand-build the path.
