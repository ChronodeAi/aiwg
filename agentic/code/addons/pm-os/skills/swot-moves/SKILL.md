---
name: swot-moves
description: >-
  Use when a finished SWOT is sitting there doing nothing and needs turning into moves — all six quadrant *pairings* worked, each producing 5–10 reusable strategy patterns rather than company-specific tactics, then unified into themes. Not for generating growth ideas from a portfolio map (`pioneer-migrator-settler`), planning from current state through the projected mess to an ideal (`scenario-plan`), or counter-positioning ideation (`disruption-what-ifs`).
---

# Generate strategic moves from a SWOT

A SWOT lists four things; the moves live in the *pairings* between them. Six pairings exist, and most teams work only the first two. Output patterns — "productize X", "partner to access Y", "standardize to reduce Z" — not company-specific tactics, unless the user asks for those explicitly.

## Step 1 — Get the context before the SWOT

Ask as one tight list, then proceed once answered: scope (company / product / business unit / career / project); industry and business model; time horizon (0–6 months, 6–18 months, 2–5 years); primary objective (growth, profitability, retention, resilience, expansion, turnaround); constraints (budget, headcount, regulatory, stack, brand, geography, risk tolerance); competitive posture (leader / challenger / niche, plus the top two competitors or "fragmented"); where value is created today (top one or two revenue drivers or success metrics); the SWOT format in use; and whether they want prioritisation, and if so by impact, effort, or risk.

Done when all nine are answered — the pairings produce generic filler without horizon, objective, and constraints in particular.

## Step 2 — Take the SWOT itself

Request 5–10 bullets each for Strengths, Weaknesses, Opportunities, and Threats, with any weighting or ranking they carry. If a quadrant comes back thin, say which pairings will be weak as a result rather than padding it yourself.

Done when all four quadrants are populated and any weighting is recorded.

## Step 3 — Work all six pairings

Four quadrants make six unique cross-pairs. Work every one:

| Pairing | Move type |
|---|---|
| S + O | Growth leverage |
| S + T | Defensive advantage — strengths that neutralise threats |
| W + O | Capability building — opportunities that fix weaknesses |
| W + T | Protective actions — reduce weakness exposure to threats |
| S + W | Focus and trade-offs — strengthen strengths, patch weak links |
| O + T | Market shaping — pursue opportunities in threat-constrained ways |

For each pairing produce 5–10 strategy patterns. Each pattern carries an optional if/then trigger — the condition that makes it most relevant — and a one-line risk or assumption note.

Done when all six pairings hold at least five patterns, each with its risk note.

## Step 4 — Build the combination matrix and themes

Map which SWOT items combine well, using lightweight matching rules rather than an exhaustive grid. Then name 3–7 strategic themes that unify patterns across pairings — "platform leverage", "risk buffering", "capability acceleration". A theme that covers only one pattern is not a theme.

Done when every theme names the patterns it unifies, and each spans more than one pairing.

## Output

Six pairing sections with their pattern sets, the combination matrix, then the strategic themes. If prioritisation was requested in Step 1, rank patterns within each pairing on the chosen axis.

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-swot-moves.md`. Never hand-build the path.
