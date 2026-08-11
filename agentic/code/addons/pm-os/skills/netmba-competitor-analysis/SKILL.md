---
name: netmba-competitor-analysis
description: >-
  Use when one named competitor needs a full teardown on Porter's four components — objectives, current strategy, assumptions, capabilities — read forward into their likely moves and the differentiation gaps those moves leave open. Also `/strategy` Step 1a, taking the crux as its focus. Not for calling match/differentiate/leapfrog on a single shipped feature (`parity-vs-differentiation`), writing the positioning statement (`positioning`), or scanning external trends for future shifts (`inflection-scan`).
---

# Tear down a competitor on Porter's four components

Porter's claim is that a competitor's next move is predictable from four things: what they want (objectives), what they are doing (current strategy), what they believe (assumptions), and what they can do (capabilities). Facts and inferences stay separated throughout — mark every inference `(Inference)` and tag every claim `[S#]` back to the evidence pack.

## Step 1 — Fix the scope

Get: our company and business unit, the focal competitor, geography and segment, time horizon, desired depth (Brief ≈600 words / Standard / Deep), and whatever facts, excerpts, and links the user holds. Ask for what is missing rather than guessing — thin input produces a confident-sounding fiction.

Done when the competitor, segment, horizon, and depth are all named and the evidence on hand is listed.

## Step 2 — Fill the four components

**Objectives:** economic goals (growth, profit, share), non-economic goals (positioning, technology leadership, ecosystem control), timeframes, and a priority ranking. **Current strategy:** target segments, value proposition, pricing and monetisation, go-to-market, roadmap themes, geographic posture. **Assumptions:** what they believe about the industry, themselves, us, and the rules of thumb their behaviour implies. **Capabilities:** cost structure, capacity, balance sheet, brand, IP, data, culture, talent, value-chain competencies, rate of learning, and the gaps.

Score each component's confidence High/Med/Low with a one-line justification. Where data is thin, state what would change your view.

Done when all four components hold concrete, testable claims, each tagged to a source, with a confidence level attached.

## Step 3 — Read the four components into likely moves

Their next moves follow from what they want, believe, and can afford. Rank probable near-term moves by likelihood × impact, note what triggers a fast response versus what they ignore, and record commitments or credible threats that lock them in. Build the likely-moves matrix: move, likelihood 1–5, impact 1–5, earliest timing, leading indicators.

Done when every predicted move traces to a specific component finding, not to intuition.

## Step 4 — Turn the read into our differentiation gaps

Name the **differentiation gaps** — where their objectives, assumptions, or capabilities leave ground they will not or cannot take. Split our response into no-regret actions and conditionals, and write the "if competitor does X, we do Y" mapping. Close with the assumptions worth testing and the fast checks that test them: customer calls, pricing pages, job posts, release notes, partner announcements.

Done when each differentiation gap names the component finding that creates it and the counter-move it unlocks.

## Output

Sections in this order: Executive Snapshot (≤120 words), Objectives, Current Strategy, Assumptions, Capabilities, Likely Moves & Response Profile, Differentiation Gaps & Implications for Us, Evidence Pack, Unknowns & Validation Plan. Include the capabilities heatmap (R&D, cost, brand, data, channel, supply chain, regulatory, hiring velocity), the likely-moves matrix, and the counter-moves plan. Bullets over prose, one idea per bullet.

Inside `/strategy`, hand forward the differentiation gaps and the likely-moves matrix — those are what Step 1b builds on.

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-competitor-analysis.md`. Never hand-build the path.
