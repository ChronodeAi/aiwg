---
name: workflow-trellis
description: >-
  Use when messy evidence — interviews, transcripts, tickets, notes, a domain
  description — has to become a *representation* of how work actually functions
  before anyone proposes automation: the durable obligation forcing the work, its
  entities and states, where the truth is fragmented, and only then where AI can
  be inserted safely. Also fires on vertical SaaS exploration and "where does AI
  fit in this workflow". Not for mapping a system's UI and code affordances
  (`breadboarding`), the end-to-end customer experience across stages
  (`journey-map`), or generating product concepts from an opportunity
  (`product-brainstorm`).
---

# Represent the work as an object, then find where AI fits

Do not start from "AI can automate X". Start by representing the work. Once the obligation, entities, states, deadlines, dependencies, evidence, fragments, and judgment points are visible, the AI opportunities stop being hand-wavy.

Tables are not decoration here. They force apart the parts of the work that prose blurs together.

Reference, loaded when a step names it: action and friction kernels and the ambient/control split ([kernels.md](kernels.md)), product primitives, mechanism families, and safety modes ([primitives.md](primitives.md)), the full output template and quality bar ([output-format.md](output-format.md)), obligation arenas and interview probes ([arenas.md](arenas.md)).

## Step 1 — Extract and name the candidates

Treat whatever the user supplied as evidence and extract workflows from it rather than brainstorming from scratch. If no market was named, start from the obligation arenas in [arenas.md](arenas.md).

Name each workflow concretely — "subcontractor insurance certificate renewal", not "compliance". Vague category names hide the work.

Ask at most three clarifying questions, and only where the answer changes the representation: which workflow or segment to model first; whether the goal is product strategy, AI feature design, customer discovery, or startup exploration; whether to favor breadth across workflows or depth on one. If the user wants momentum, skip the questions and state assumptions.

Done when 3–6 candidates are named at that level of concreteness, each traceable to something in the source material.

## Step 2 — Run the three gates

Score each candidate on all three:

1. **Durable obligation** — the work exists because law, money, customers, operations, professional standards, auditability, or accountability demand it.
2. **Fragmented representation** — the truth of the work is split across spreadsheets, emails, PDFs, portals, desktop apps, messages, forms, humans, vendors, or legacy systems.
3. **Hated execution burden** — the recurring work is tedious, anxiety-producing, deadline-bound, error-prone, or annoying enough that users already complain about it.

Label rather than discard: **strong** (all three present), **partial** (one gate weak or unclear), **weak** (pain is optional, one-off, or high-judgment with no repeatable representation).

Done when every candidate carries a label and a per-gate justification, and 1–3 are selected for deep modeling.

## Step 3 — State the obligation

For each selected workflow, write one sentence: `[Actor] must [produce/verify/decide/submit/reconcile/respond] [artifact/outcome] by [deadline/trigger] because [external force/consequence].`

Look for filings, payments, reconciliations, reports, renewals, certifications, approvals, customer commitments, safety checks, billing events, audits, handoffs, inspections, status updates.

Done when the sentence names an actor who is accountable when the work is late, wrong, or missing, and an external force that makes it recur.

## Step 4 — Represent the workflow

Lay out the building blocks: **actors**, **entities**, **states**, **transitions**, **deadlines**, **permissions**, **dependencies**, **evidence**, and **definition of done**.

Done when every state has at least one transition into and out of it, and "done correctly" is stated as something checkable rather than a feeling.

## Step 5 — Map the fragments

Where does the truth live today? Which systems do people manually compare, copy between, or reconcile? Which humans act as routers between tools?

Build the fragment map: fragment, what it contains, owner, update frequency, failure mode.

Done when every fragment names its failure mode, and the unofficial source of truth is identified by name.

## Step 6 — Find the action and friction kernels

Decompose each meaningful step into the human action it contains and the part of that action that creates friction, using the vocabularies in [kernels.md](kernels.md). For each, name the missing ingredient — information, evidence, confidence, language, timing, or authority — that would let the person move forward.

Done when every step has one action kernel, one friction kernel, a missing ingredient, what software could prepare, and what must stay human — and no step has jumped to a mechanism.

## Step 7 — Split ambient from control

Classify each step by surface type using [kernels.md](kernels.md). Some work should disappear into the background; work carrying uncertainty, consequence, authority, relationship risk, legitimacy, or audit requirements should not.

Done when every step carries a surface type, a reason drawn from the go-ambient and needs-control conditions, and a statement of what the user sees.

## Step 8 — Convert friction into product primitives

For each surfaced opportunity, specify all six fields — primitive, system behavior, inputs used, output produced, user control, build spark — from [primitives.md](primitives.md).

Done when every build spark is concrete enough for a designer to sketch and a developer to name the data structures, integrations, or model work.

## Step 9 — Name the insertion points and the exception queue

Assign each automation candidate its role, mechanism family, safety mode, confidence signal, human control surface, and risk, using [primitives.md](primitives.md). The mechanism is chosen last, after the kernels, surface type, and primitive are settled.

Then define the exception queue: exception type, why it surfaced, evidence shown, suggested action, required human decision, escalation path. A mature workflow demotes humans from operators to exception managers — they see the work when confidence is low, stakes are high, evidence conflicts, deadlines are at risk, or accountability requires judgment.

Done when every insertion point has a confidence signal and a named human control surface, no candidate defaults to an LLM without the alternatives being ruled out, and the exception queue has at least one entry with an escalation path.

## Step 10 — Draw it and say what it changed

Draw the Mermaid workflow diagram showing actors, artifacts, states, fragments, ambient actions, surfaced controls, and handoffs. Then write **Intuition Gained** — the non-obvious thing the representation revealed — and **Product Implications** — what the product should capture first, which steps go ambient, what should not be automated, and what prototype would test the model.

Done when both sections name something the raw source material did not already say, and neither reads as a restatement of the tables.

## Output

Follow the structure in [output-format.md](output-format.md) exactly, then check the result against its quality bar and red flags.

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-workflow-trellis-{workflow-slug}.md`. Never hand-build the path.
