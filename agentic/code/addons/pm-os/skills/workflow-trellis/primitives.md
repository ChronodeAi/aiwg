# Primitives, mechanisms, and safety modes

What a friction point becomes once it is concrete enough to design and scope.

## Product primitives — the object the user sees

Smart field · Suggested mapping · Exception card · Review queue · Readiness checklist · Evidence packet · Confidence badge · Batch approval tray · Diff view · Chase draft · Escalation banner · Audit timeline · Simulation or preview · Override rule · Delegation task · Stale-work resurfacer

For each opportunity, specify all six:

- **Product primitive** — the UI or workflow object the user interacts with.
- **System behavior** — what the software does, concretely.
- **Inputs used** — which records, messages, documents, fields, or history it reads.
- **Output produced** — the artifact, recommendation, state change, draft, warning, or queue item that appears.
- **User control** — what the human can approve, edit, reject, override, batch, delegate, or escalate.
- **Build spark** — one sentence concrete enough that a designer could sketch it and a developer could name the data structures, integrations, or model work.

## Automation roles

Extract · Classify · Match · Draft · Check · Route · Remind · Reconcile

## Mechanism families — pick after the primitive, not before

- **System integration / API fill** — fetch or sync trusted data instead of asking a human to re-enter it.
- **Rules and state machines** — encode deadlines, required evidence, permissions, transitions, and escalation paths where the logic is explicit.
- **OCR / document AI / extraction models** — read invoices, forms, PDFs, screenshots, receipts, printed or handwritten documents.
- **LLM text generation** — draft emails, summaries, explanations, checklists, memos, or user-facing copy where language *is* the work.
- **LLM reasoning over messy context** — summarize threads, compare evidence, explain conflicts, propose next steps where inputs are semi-structured and judgment-adjacent.
- **Embeddings / semantic search / entity resolution** — find similar records, match fuzzy names, cluster documents, retrieve prior examples.
- **Prediction / scoring models** — estimate risk, priority, delay likelihood, anomaly probability, churn, default, or escalation need. Use the simplest model the evidence supports, from rules or logistic regression up to tree models and learned rankers.
- **Optimization / scheduling** — allocate people, routes, inventory, appointments, or queues under constraints.
- **Workflow orchestration** — create tasks, reminders, approvals, handoffs, and audit trails across systems.
- **Human-in-the-loop review** — require approval where stakes, ambiguity, relationships, or accountability stay high.

Defaulting to an LLM is the common failure. Deterministic software, an API integration, a rule, or OCR is often the correct mechanism.

## Safety modes

- **Autopilot** — low stakes, reversible, clear success criteria.
- **Copilot** — AI drafts or recommends, human approves.
- **Guardrail** — AI checks the work and flags issues.
- **Do not automate** — high-stakes judgment, unclear ground truth, relationship-sensitive, or accountability-heavy.
