---
name: interface-4-lenses
description: >-
  Use when one interface image needs describing in four different
  registers for four different audiences — novice instructions, a
  technical process flow, an ELI5 simplification, and a casual/social
  tone. Not for translating a PM's context into design requirements
  (`pm-to-design`), or reacting to a decision from one specific segment's
  lens (`persona-lens-decision`).
---

# Describe one interface in four registers

The same interface reads differently to a first-time user, an engineer mapping the flow, someone testing whether you actually understand it, and someone skimming a social post about it. Each register has to stand alone — none may borrow the others' vocabulary.

## Step 1 — Take the image

Get the interface image to describe. Base every description strictly on what's visible — never invent elements not shown.

Done when the image is in hand and every visible element is identified before writing begins.

## Step 2 — Write novice instructions

Step-by-step instructions for a first-time user, in simple language, explaining each interface element as it's encountered.

Done when a novice could follow the interface using only these instructions.

## Step 3 — Write the process flow

A textual process diagram of the interface's flow, using `[ ]` for steps, `( )` for decisions, and `->` for connections.

Done when the flow is represented as connected steps and decisions, not prose.

## Step 4 — Write the ELI5 version

An explanation simple enough for a young reader — short sentences, plain vocabulary, describing what's seen and what it seems to do.

Done when the explanation uses no jargon and no term a young reader wouldn't know.

## Step 5 — Write the casual/social version

A short, informal description in a casual, social-post tone — plain-spoken and low-effort in register, not dependent on slang or memes that age out.

Done when the description reads as casual and shareable, distinct in tone from all three prior registers.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-interface-4-lenses-{tool-slug}.md`. Never hand-build the path.

The doc holds: all four descriptions, each labeled by register.
