---
name: ost-intake
description: >-
  Use when an Opportunity Solution Tree is about to be built and its four inputs need eliciting and normalizing first — outcome, journey nodes as *moments in time*, interview material, constraints — parsing whatever the user already provided before asking anything. Also `/opportunity` Step 1. Not for building the tree from those inputs (`ost`), selecting a target from a built tree (`ost-prioritize`), or scoping a research study (`research-brief`).
---

# Gather and normalize the OST inputs

Four variables, exactly. Parse first, ask second — anything already in the user's files or message is extracted before a single question gets asked, and confirmed rather than re-elicited.

| Variable | Normalized form |
|---|---|
| `business_outcome` | One concise sentence, outcome-focused, naming no solution |
| `journey_nodes_as_list` | JSON array of distinct **moments in time**, 2–9 items |
| `interview_transcripts_or_story_snippets` | Markdown with speaker labels and timestamps where available |
| `constraints_or_principles` | Short markdown list or sentence (optional) |

## Step 1 — Parse the existing context

Read whatever text or files the user provided and draft initial values for all four variables. Detect outcome statements, journey stages, interview notes, and constraints already present.

Done when all four variables hold a draft value or are explicitly marked missing.

## Step 2 — Ask only for what is missing or malformed

Skip any variable that is already present, clear, distinct, and normalized. For the rest:

- **Outcome** (missing, unclear, or solution-flavoured): what single measurable outcome — behavioural or business — should this drive, phrased without naming a solution? Whose behaviour changes, and how would you observe it? What timeframe or leading indicator matters?
- **Journey nodes** (missing, unclear, or mixed with features): list the distinct moments in time for the customer journey in scope — "Discover", "Decide", "Onboard", "Use", "Review" — each a brief verb phrase. Do any overlap or repeat? Any upstream or downstream moments to exclude for now?
- **Interview material** (missing, thin, or unattributed): paste snippets with speaker labels and timestamps. Per snippet, a context line (persona, scenario) then 1–3 representative quotes. With no transcripts, summarise each interview: who, when, situation, and verbatim quotes where possible.
- **Constraints** (absent or implicit): any constraints, principles, or scope boundaries — compliance, platform limits, segments, markets, languages, accessibility, deadlines?

Done when every variable has a value the user supplied or confirmed.

## Step 3 — Normalize and guard the quality

Reframe a solution-flavoured outcome into an outcome — "build X" becomes "increase weekly active collaborations by 15%". Rephrase feature-shaped journey nodes into moments — "notifications" becomes "Review schedule for tomorrow". Add minimal attribution where interview material lacks it: "Interview 3 — PM — 2026-09-10". Where the user is unsure of the journey, propose a pragmatic 3–6 node default for their domain and confirm it.

Done when every variable matches its normalized form in the table above.

## Step 4 — Confirm before emitting

Show the draft of all four fields and ask: does this look correct and complete, any changes to wording, scope, or moments? Apply the edits.

Done when the user has confirmed the draft — not when it merely looks complete.

## Output

Emit exactly once, after confirmation:

```
business_outcome: <one sentence>
journey_nodes_as_list: ["<moment>", "<moment>", ...]
interview_transcripts_or_story_snippets: |
  <markdown, speaker-labelled, timestamped>
constraints_or_principles: <short list or sentence, or "none">
```

Inside `/opportunity`, hand this block straight to `ost` as Step 2's input.
