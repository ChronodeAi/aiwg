---
name: eng-shape
description: >-
  Use when a PM wants application *archetypes* instead of a single answer or an internal-architecture call. Three openings: "I want to build X — what's out there?"; "I want to do X — what kind of app is this even?"; "they said it should be a Slack app — is it?". Returns 3 archetypes backed by real GitHub repos and a paragraph the user can paste to an AI builder. Not for an engineering team's internal architecture call (`tech-arch-brief`), bug triage (`bug-triage`), or translating a decided plan to stakeholders (`tech-to-business`).
---

# Find application archetypes

## Step 1 — Pick the entry path

Three openings. Pick the branch from the user's first message; ask if unclear.

- **A. "Build X — what's out there?"** — A goal, no shape in mind. Go to Step 2A.
- **B. "What kind of application is this?"** — A need, no idea what form factor solves it. Go to Step 2B.
- **C. "They said it should be a [shape] — is it?"** — A shape has been prescribed. Go to Step 2C.

Done when the branch is named and the user has answered three questions about context: **who triggers it, who consumes the output, where it runs**. If any answer is missing, ask in one question before continuing.

## Step 2A — Scan GitHub for existing implementations

Search GitHub for repos solving the same problem from two or three different search angles. Use WebSearch + WebFetch, or the github MCP if available. Open the top 4–8 candidates and read each README and any architecture notes.

Done when at least 5 real, currently-maintained repos have been read and each has its core assumption named in one sentence.

## Step 2B — List candidate archetypes from the three answers

From the three context answers, list every archetype that plausibly fits. Common candidates: Slack bot, email-only worker, multi-channel router, internal dashboard, browser extension, GitHub Action, Zapier integration, CLI, service-with-API, scheduled worker. Cross out any archetype that fails one of the three answers, with one sentence saying why.

Done when 3–5 archetypes survive elimination, each named with the answer it satisfies. Then go to Step 2A to ground each survivor in a real repo.

## Step 2C — Name the assumption behind the prescribed shape

State the prescribed shape and the assumption it rests on (e.g., "Slack bot assumes everyone is in Slack and notifications must be interruptive"). Then go to Step 2A or 2B to produce 1–2 alternative shapes resting on different assumptions.

Done when the assumption is named in one sentence and at least one alternative shape is named for the next step.

## Step 3 — Cluster into archetypes and back each with a real repo

Group what the scan produced into 3 archetypes that differ at the **core assumption** they rest on, not at parameters. Two archetypes resting on the same assumption count as one — collapse them. For each archetype, name one real GitHub repo as the reference instance with its URL.

Done when there are 3 archetypes, no two share a core assumption, and each has a real fetched URL — not an invented one.

## Step 4 — Score each archetype against the three answers

For every archetype, rate against the user's three answers on three axes:

- **Fit** — does it match who triggers, who consumes, and where it runs?
- **Friction to ship** — how much custom work before there's a v1 the team can use?
- **Friction to extend** — what's the next thing the user will want, and how hard does this archetype make it?

Done when every archetype has a one-line score on each axis.

## Step 5 — Recommend one and say what would change the recommendation

Pick the archetype that wins or ties on the most axes. State what measurable change in the user's situation — a new channel, a new team, a deadline, a budget — would make you pick a different archetype.

Done when the recommendation names a specific archetype (not "a system that…") and the change condition is a single checkable fact.

## Step 6 — Write the paragraph the user pastes to an AI builder

Write one paragraph (~120 words) that names the archetype concretely, names the reference repo to model it on, lists the three context answers, names the must-have channels and integrations, and names what to *not* build for v1. Plain language, no marketing.

Done when the paragraph is paste-ready, names the archetype by shape (e.g., "a multi-channel router with adapters for Slack, email, and Teams"), and includes the reference repo URL.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-eng-shape-{problem-slug}.md`. Never hand-build the path.

The doc holds: the three context answers, the three archetypes with reference repos, the score table, the recommendation, the change condition, the paste-ready paragraph.
