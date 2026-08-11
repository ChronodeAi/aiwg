---
name: product-brainstorm
description: >-
  Use when a problem or opportunity area needs *product concepts* — each stated as problem + mechanism + differentiation, with technology nouns banned so the concept can't hide behind a buzzword. Fires on "product ideas for X," "what could we build here." Not for topic ideation (`brainstorm-genius`), ideation inside hard constraints (`constrained-ideas`), or question-driven startup ideation (`startup-ideas`).
---

# Generate product concepts by mechanism, not technology

A product concept is a *mechanism*: how the thing works to solve the problem. Technology nouns — AI, blockchain, VR, "an app," "a platform" — are banned from concept statements, because "use AI for X" is a technology choice wearing a concept's clothes. The test: if a reader could build the concept three different ways, it's a mechanism; if it names its own implementation, it isn't.

## Step 1 — Pin the problem space

Get the problem or opportunity area and who has it — the person and the situation, not a market label. If the user arrives with a solution ("ideas for an AI meeting tool"), strip it back to the problem it implies ("people leave meetings without knowing who owns what") and confirm.

Done when the problem is one sentence about a person's situation, and any smuggled solution has been stripped and confirmed.

## Step 2 — Map how it's solved today

List 2–4 ways people handle this problem now — products, workarounds, or doing nothing — and where each one fails the person. The failures are where concepts live; a concept that doesn't beat a named failure is a me-too with fresh paint.

Done when each current alternative has a named failure, in terms of what the person still can't do or must endure.

## Step 3 — Generate concepts mechanism-first

For each failure, ask: what mechanism would remove it? Generate 5+ candidate concepts, each described in one or two sentences of pure mechanism — what happens, in what order, that solves the problem. Run the noun ban on every one: no technology names, no product-category names. A concept that fails the ban gets rewritten as its mechanism or cut.

Done when there are 5+ concepts, every one passes the noun ban, and each names the failure it removes.

## Step 4 — Develop the strongest three

Pick the 3 strongest and write each as a full concept statement: **the problem** (one line), **the mechanism** (how it works, still noun-banned), **the key innovation** (the one thing about the mechanism that wasn't possible or wasn't tried before), and **why it beats the alternatives** (against the Step 2 failures, not in general). Apply the three-ways test once more — a concept statement that survives it is implementation-ready without prescribing the implementation.

Done when each of the three has all four parts and survives both the noun ban and the three-ways test.

## Step 5 — Name each concept's riskiest assumption

For each concept, state the one assumption that kills it if false — usually about the person's behavior, not the buildability — and the cheapest check: a conversation, a landing page, a concierge run of the mechanism by hand.

Done when every concept has one named assumption and a check runnable within two weeks.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-product-brainstorm-{problem-slug}.md`. Never hand-build the path.

The doc holds: the problem space, the current alternatives with failures, the concept candidates, the three developed concept statements, the riskiest assumptions with checks.
