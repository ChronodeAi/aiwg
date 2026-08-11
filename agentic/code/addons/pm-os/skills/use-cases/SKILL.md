---
name: use-cases
description: >-
  Use when research notes or a raw product idea need to become Cockburn-style
  use cases — actor, goal, trigger, main success scenario, extensions and a
  testable success criterion each — validated against CRISP before anything
  downstream depends on them. Also /prd Steps 1c and 3. Not for extracting
  requirements from a meeting transcript (`requirements-from-talk`), a
  business-level actor-and-goal map before product work (`use-case-map`),
  agile role-goal-benefit stories (`user-stories`), or Given/When/Then
  acceptance criteria (`gherkin-stories`).
---

# Write Cockburn-style use cases

Alistair Cockburn's discipline, from *Writing Effective Use Cases*: a use case is one actor pursuing one goal, described as what they want rather than what the system does. Most bad use cases fail the same way — the system is the subject, or "done" isn't observable.

Inside `/prd` this is Step 1c (research → use cases) or Step 3 (requirements → use cases). Standalone, start from whatever the user has.

## Step 1 — Establish what the user has

Ask what research, notes or data exist, who the target users are, and what problem is being solved. Sort the answer into one of three starting points: structured research, unstructured research, or an idea with no validation.

Done when the starting point is named and the user has confirmed it.

## Step 2 — Identify the actors

Name the **primary actor** (initiates and achieves the goal), the **secondary actors** (respond, approve, or are affected), and the **system actors** (external systems). The test: who benefits, who does the work, who gets notified.

Two actors doing the same thing means the split is wrong — merge them.

Done when every actor is classified primary, secondary or system, and each has a role distinct from the others.

## Step 3 — Extract the candidate use cases

If the input is research, read [`research-intake.md`](research-intake.md) — it holds the synthesis format, the mapping from finding frequency to use-case priority, and a worked before/after. If the input is an idea with no research, ask the four scaffolding questions: what would a user *do* with this, what changes after they use it, describe a specific person using it, what do they do today instead.

Done when every candidate use case traces to a named finding, a stated workaround, or an answer to one of the four scaffolding questions.

## Step 4 — Write each use case

Fill this template per use case:

```
**Use Case:** [ID]: [Name — active verb + noun, "Generate Invoice" not "Invoicing"]
**Actor:** [Primary actor]
**Goal:** [What the actor wants — one sentence]
**Preconditions:** [What must be true before this starts]
**Trigger:** [What starts it]

**Main Success Scenario:**
1. [Actor does X]
2. [System responds with Y]
   … 3–7 steps, ending at the goal

**Success Criteria:** [Observable, testable]

**Extensions:** 3a. [Condition]: [What happens instead]
**Failure Scenarios:** [What can go wrong, and how it's handled]
**Meta:** Frequency=[…], Priority=[must / should / nice]
```

Worked examples across research-driven, idea-driven, B2B-permissioned and fully-dressed Cockburn form are in [`examples.md`](examples.md).

Done when every candidate from Step 3 is written in this template with no field left blank.

## Step 5 — Validate against CRISP

Check each use case on five criteria — **C**oncrete (can you describe a specific instance?), **R**ole-defined (is the actor clear?), **I**ndependent (can this happen without other use cases?), **S**uccess-measurable (do we know when it's done?), **P**roblem-aligned (does it solve the stated problem?).

Any failure sends the use case back to Step 4. For a final pass before the set goes downstream — Cockburn's 28-point checklist, goal levels, and the anti-pattern conversions — read [`validation.md`](validation.md).

Done when every use case passes all five CRISP criteria, none deferred.

## Step 6 — Check the set for coverage

Check breadth (every actor from Step 2 has at least one use case), depth (every use case has a complete happy path), edge cases (what can go wrong is captured), and priority (which use cases matter most). Note which use cases depend on which.

Done when every actor is covered, every use case is prioritised, and the interdependencies are listed.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-use-cases-{product-slug}.md`. Never hand-build the path.

The doc holds: the actor summary, the use cases ordered by priority, the interdependencies, the CRISP validation summary, and the open questions.
