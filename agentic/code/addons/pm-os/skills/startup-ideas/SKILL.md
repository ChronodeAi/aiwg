---
name: startup-ideas
description: >-
  Use when a user's answers to discovery questions (goal, process, pain
  points, time or money spent) need turning into 10 software product
  concepts, each one worth $30/month to that user. Not for
  problem+mechanism+differentiation product concepts from a stated
  problem area (`product-brainstorm`), or open-topic idea breadth
  (`brainstorm-genius`).
---

# Turn discovery answers into 10 worth-paying-for concepts

## Step 1 — Take the discovery answers

Get the user's responses covering: their overall goal, the process steps involved, where they currently are in that process, where the pain point sits in their workflow, where they lose significant time or money, how often the problem occurs, and what they've already tried.

Done when the goal, process, pain point location, and frequency are all identified from the responses.

## Step 2 — Generate 10 concepts

For each concept: a catchy name and a 40-80 word description tied to a specific pain point or opportunity from Step 1, explaining how it streamlines the process or solves the problem. Cover different angles of the user's workflow — don't cluster all 10 around the same pain point.

Done when 10 concepts are written, each with a name and description, and each tied to a distinct pain point or workflow moment from Step 1.

## Step 3 — Check the $30/month bar

For each concept, state in one line why this specific user would call it a bargain at $30/month — not why it's a good idea in general.

Done when every concept has a stated reason tied to this user's specific pain, not a generic value claim.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-startup-ideas-{topic-slug}.md`. Never hand-build the path.

The doc holds: the 10 concepts with names, descriptions, and the $30/month justification for each.
