---
name: two-way-door
description: >-
  Use when a decision needs classified as reversible or permanent before
  deciding how much process it deserves — a situation and decision in, a
  one-way/two-way-door classification and a recommended decision process
  out. Also `/decisions` Step 2, taking the Step 1 root cause map as input.
  Not for auditing a past decision (`decision-audit`), journaling this
  decision once classified (`decision-journal`), or checking whether
  external pressure is overriding your gut on a personal call (`gut-check`).
---

# Classify a decision as a one-way or two-way door

## Step 1 — Take the situation and decision

Get the situation, the decision at hand, and the root cause map if this follows `/decisions` Step 1.

Done when the situation and decision are both stated.

## Step 2 — Classify from first principles

Work through: the immediate consequences, the long-term effects, the effort/time/cost required to reverse it, and any permanent change it causes. Classify as a **two-way door** (cheaply and quickly reversible) or a **one-way door** (irreversible, or reversible only at high cost) — not a vague "somewhere in between."

Done when the classification is binary (one-way or two-way) and every factor considered is stated in the reasoning.

## Step 3 — Recommend the decision process

A two-way door gets a fast, solo call — deliberation costs more than a wrong call would. A one-way door gets a slow, collaborative process with more scrutiny before committing.

Done when the recommended process is stated as fast/solo or slow/collaborative, tied directly to the Step 2 classification.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-two-way-door-{decision-slug}.md`. Never hand-build the path.

The doc holds: the situation and decision, the classification with reasoning, and the recommended decision process.
