---
name: icp-roleplay
description: >-
  Use when a PM wants to interrogate a product decision by talking *to* the ideal customer rather than about them — a first-person roleplay that answers only from specific recent episodes and refuses hypotheticals, aggregates, and speaking for other users. Not for a third-person analytical read of how one segment reacts to a decision (`persona-lens-decision`), synthesizing real interview transcripts (`interview-insights`), or generating a simulated JTBD interview transcript (`jtbd-transcript-sim`).
---

# Roleplay the ideal customer

The value of this roleplay is the *refusal*. A simulated customer who answers hypotheticals produces the PM's own assumptions in a customer's voice — which is worse than no answer, because it feels like evidence. Every answer here is an episode: a specific time, a specific situation, a specific outcome.

## Step 1 — Build the character

Get from the PM: the product, the ICP segment, a name for the character, their role and daily workflow, the tools around the product, and how long they have used it. Where the PM has real research — interview notes, support tickets, session recordings — take it; the roleplay is only as grounded as what it is built from.

Say plainly what is inferred rather than sourced, so the PM knows which answers to trust.

Done when the character has a name, a workflow, a tool context, and a stated line between researched and inferred detail.

## Step 2 — Answer in episodes

Stay in first person and in character. Every answer starts from a specific recent instance — "last Tuesday when I was…", "this morning I realised…" — with the context, timing, and circumstances of that episode, what worked, what did not, and why it mattered.

Match the question type:

- **Feature question** → the last time a situation made this feature relevant.
- **Value question** → a specific instance where the value landed, or was missed.
- **Workflow question** → the actual recent workflow, step by step.
- **Pain question** → the exact moment the pain was felt, and what happened next.

Done when every answer names a specific occasion rather than a general tendency.

## Step 3 — Redirect what cannot be answered from experience

Three redirects, used verbatim in spirit:

- "What would you do if…" → "I don't know about hypotheticals, but let me tell you about the last time I actually…"
- "How do users typically…" → "I can't speak for other users, but here's what happened to me on…"
- "How often do you…" → "Let me think about this week specifically…" then give the concrete instances.

Say "I don't know" when the experience is absent, and admit when experience is thin or situation-specific. Never aggregate episodes into a general pattern, never speak for other users, never give feedback on something never encountered.

Done when every hypothetical, aggregate, and speak-for-others question has been redirected to an episode or answered "I don't know".

## Step 4 — Break character and mark the seams

Close by stepping out: which answers rested on real research, which were inferred, and which questions the roleplay could not honestly answer. Those last ones are the interview guide — they are what a real customer needs to be asked.

Done when every answer is labelled researched or inferred, and the unanswerable questions are listed as research to run.

## Output

The transcript of the exchange, then the break-character section: researched vs inferred answers, and the open questions to take to a real customer.

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-icp-roleplay.md`. Never hand-build the path.
