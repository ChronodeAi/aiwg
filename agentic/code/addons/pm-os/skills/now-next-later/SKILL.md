---
name: now-next-later
description: >-
  Use when user interviews need turning into a Now/Next/Later roadmap where every item is grounded in a quote — needs separated from the symptoms and proposed solutions users voice, then placed on the horizon where each becomes *critical*. Not for bridging a vision deck into this quarter's work (`vision-to-quarter`), triaging one week's pile (`weekly-top-3`), or building an opportunity tree from the same interviews (`ost`).
---

# Turn interviews into a Now/Next/Later roadmap

Users describe symptoms and name solutions; neither is a need. The roadmap is built from needs, and every need is anchored to something a user actually said.

Work from these four distinctions throughout:

- **Need (what)** — the underlying requirement or outcome, never a tool or feature.
- **Symptom (signal)** — the pain or friction the user experiences.
- **Proposed solution (how)** — a tool or feature the user names; map it back to the need beneath it.
- **Underlying driver (why)** — the root cause, motivation, or job-to-be-done the need serves.

## Step 1 — Take the transcript

Get the full conversation text with speaker labels and timestamps where available, plus any background the user has — brief, role, goals. Partial notes work; say what the thinness will cost in evidence quality rather than filling gaps yourself.

Done when the transcript is in hand and any accompanying context is noted.

## Step 2 — Extract needs with their evidence

Read the whole transcript before extracting anything — recency bias makes the last ten minutes look like the priority. Prefer recurring patterns over isolated spikes. For each need, capture the symptom it surfaced through, the solution the user proposed if any, and the driver beneath it.

Ground every need in a direct quote of ≤20 words or a precise paraphrase, cited with participant id and approximate timestamp — `[P02 ~14:30]`. Start the quote where the thought begins and run to where it is fully expressed; keep the reasoning, not just the conclusion; keep hedges and qualifiers, since they signal uncertainty; keep emotional language. Never splice statements from different parts of the interview, and break anything over three sentences into separate quotes.

Do not infer a need without evidence. If a horizon ends up with fewer than two supported items, return only what is supported.

Done when every extracted need carries a cited quote and is classified against the four distinctions.

## Step 3 — Place each need on a horizon

**Now** — urgent pains and blockers stopping progress today. **Next** — needs that become critical once Now is unblocked; near-term momentum. **Later** — transformational outcomes and end states tied to strategy. A need that spans horizons goes where it becomes *critical*, with the cross-horizon nature noted in its rationale.

Done when every need sits on exactly one horizon, and any cross-horizon need says so in its rationale.

## Output

Exactly three sections — **Now**, **Next**, **Later** — with 2–4 items each, or fewer where evidence is insufficient. Each item:

```
### [Need stated as an outcome, not a feature]
- **Symptom:** what the user experiences
- **Proposed solution (if voiced):** what they asked for, and the need it maps to
- **Underlying driver:** the job or motivation beneath it
- **Evidence:** "quote" [P0X ~MM:SS] — plus any further citations
- **Rationale:** why this horizon, and whether it spans others
```

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-now-next-later.md`. Never hand-build the path.
