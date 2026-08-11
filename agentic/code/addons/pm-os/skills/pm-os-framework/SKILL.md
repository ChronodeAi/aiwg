---
name: pm-os-framework
description: >-
  Use when the user wants to find a framework, asks 'what framework should
  I use', or says '/framework'. Not for finding a PM skill for a specific
  task (`pm-os-skill`) or a full system tour (`pm-help`).
---

# /framework [topic] — Index

## When to use

Type `/framework` followed by a topic, problem, or question. Examples:

- `/framework prioritization`
- `/framework how to map stakeholder power`
- `/framework early-stage discovery`
- `/framework what to measure for growth`

## How it runs

1. Read `knowledge/INDEX.md` — this is the master map of all frameworks, articles, and exercises. Note the "Used in" column for workflow linkage.
2. Delegate to `agents/knowledge-librarian.md` for matching and retrieval
3. Present top 3–5 matches, each with:
   - **File path** — where to find the full framework
   - **One-sentence principle** — what the framework does
   - **Best used when** — the situation where this framework applies
   - **Workflow** — which workflow(s) use it (e.g., "surfaced in `/strategy`"), or "standalone" if no workflow references it
   - **Related** — 1-2 related frameworks in the same folder
4. Ask which to explore deeper
5. When the user picks: retrieve the file and explain the framework fully

Done when the user has picked a match and the full framework has been retrieved and explained.

## Scope

Searches across all Knowledge subfolders:

- `knowledge/Frameworks/` — 118 PM lifecycle framework files across discovery / validation / build / grow
- `knowledge/Prioritization/` — 50 tagged prioritization frameworks
- `knowledge/Resources/Lenny-Newsletter/INDEX.md` — 260 curated newsletter article links
- `knowledge/PM Tasks/` — 25 PM exercises and practice drills
- `knowledge/Interview-Questions/` — 100 interview questions across 6 categories
- `knowledge/Metrics/` — 41 north star examples by company

Additionally, the `lenny-podcast` MCP server provides live search across 284 Lenny's Podcast episode transcripts. When a topic search could benefit from podcast insights (especially guest opinions on PM practices), use the `search_transcripts` tool as a supplementary source alongside the static knowledge/ files.

## Note

If the topic maps clearly to one of the 10 PM workflows (`/strategy`, `/opportunity`, `/assumptions`, `/research`, `/decisions`, `/stakeholder`, `/meeting`, `/review`, `/coaching`, `/measure`), note that and offer the full workflow as the primary path — it sequences multiple frameworks for deeper results. `/framework` is best for standalone lookups and enrichment.
