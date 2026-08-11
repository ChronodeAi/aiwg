---
name: tech-sensemaking
description: >-
  Use when a technology announcement needs reading for what it changes about
  *your* situation — a neutral summary, a context block on the subject it
  lands on, then tail-sampled generation across four frames (new outcomes,
  new affordances, relative value, secret levers), critiqued down to a top
  three moves. Not for the sampling mechanics themselves
  (`verbalized-sampling`), scanning a market for inflection points
  (`inflection-scan`), running disruption scenarios against your own product
  (`disruption-what-ifs`), or getting oriented inside an unfamiliar codebase
  (`vibe-code-leaf-finder`).
---

# Read a tech announcement for what it changes

Most reactions to an announcement are the tech-journalist take: what it is, who it threatens, why it matters in general. The value is in what it changes for one specific subject, and that only appears when the announcement is held against rich context about that subject.

Generation mechanics come from `verbalized-sampling` — distribution thresholds, failure modes, output formatting. This skill owns the intake, the context, the four frames, and the critique.

## Step 1 — Summarise the announcement neutrally

Accept the announcement as pasted text, a URL (scrape it) or a description. Write a 200-400 word neutral summary: what was announced, what constraints or limitations were named, availability and timeline, and what was conspicuously *not* said.

Show it to the user and ask whether it captures the announcement before analysing anything.

Done when the summary covers all four elements and the user has confirmed or corrected it.

## Step 2 — Build the context block

Ask what to analyse the announcement against — a business, a product or feature, a codebase or branch, a personal project, a role, or an open exploration. Then load context from the matching source:

| Context type | Where to look | What to extract |
|---|---|---|
| **Business** | Vault notes, `📂 Context/` files, user description | What it does, revenue model, competitive position, goals, constraints, team size |
| **Product** | README, product docs, vault notes, user description | What it does, target users, current capabilities, roadmap, tech stack |
| **Codebase / branch** | Source, README, CLAUDE.md, recent commits and PRs | Architecture, dependencies, current problems, what's being built |
| **Personal project** | Vault notes, user description | Goals, constraints, timeline, what's been tried |
| **Role / career** | Vault notes, user description | Current role, skills, goals, industry, constraints |
| **Generic** | User description, web research | Domain, key players, known constraints, relevant trends |

Compress into ~300 words covering what the subject is, its current state, its direction, its key constraints, and what has already been tried.

Done when the context block covers all five elements. If it is thin, say so and ask the user to enrich it before generating — thin context is the primary cause of generic output (`verbalized-sampling` FM-2).

## Step 3 — Generate across four frames

Read [`references/vs-prompts.md`](references/vs-prompts.md) for the four templates and substitute the summary and context block into each.

| Frame | Key | What it surfaces |
|---|---|---|
| New outcomes | `new_outcomes` | What's now possible, including second- and third-order effects |
| New affordances | `new_affordances` | What actions can now be taken — concrete, effort-rated |
| Relative value | `relative_value` | Which possibilities matter most for *this* subject versus alternatives |
| Secret levers | `secret_levers` | Non-obvious causal chains toward durable advantage |

Configuration: VS-CoT variant (each output carries a `reasoning` field), tail sampling at p < 0.10, k = 5 per frame. The templates carry the exclusion constraints (FM-1) and the coverage requirements within each frame (FM-3); the context block handles FM-2.

Done when all four frames have run and 20 outputs exist, each with a probability and reasoning.

## Step 4 — Critique and triage

Run the critique loop from `verbalized-sampling` (see its `references/critique-framework.md`) over all 20. Score each on six dimensions: naive (would a tech journalist write this?), under-specified (could execution start this week?), magical thinking (does it assume steps just work?), ignores constraints (does it violate the context block?), base-rate blind (is this known to fail in similar contexts?), over-engineered (a cannon for a fly at this scale?).

Triage by failure count: 0-1 keep as-is · 2-3 generate two improved variants and pick the better · 4+ drop.

Done when all 20 outputs carry a failure count and a triage verdict.

## Step 5 — Present

Group by frame, ordered by probability ascending so the most novel reads first, with the condensed reasoning under each. Then add two closing sections: **Top 3 moves** across all four frames — each with what to do, why this announcement opens the window, and the concrete first step — and **What I excluded and why**, naming 2-3 dropped items with their failure reasons so the user can calibrate against what "obvious" looks like.

Done when every surviving output is grouped and ordered, the three moves each carry a first step, and the exclusions section names at least two dropped items.

## Notes

- Freshness matters. An announcement more than a few days old produces outputs closer to what has already been said publicly.
- For a major platform shift rather than a feature announcement, run this twice: once on the announcement, once on the second-order market reactions a week or two later.
- Secret levers (frame 4) is the highest-value output. Under time pressure, run frame 4 alone.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-tech-sensemaking-{announcement-slug}.md`. Never hand-build the path.

The doc holds: the announcement summary, the context block, the surviving outputs by frame, the top three moves, and the exclusions.
