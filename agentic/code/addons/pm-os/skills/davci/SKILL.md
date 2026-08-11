---
name: davci
description: >-
  Use when aiming to establish structured decision-making protocols with
  defined roles and responsibilities — a decision and its stakeholders in, a
  Decider/Approver/Veto/Consulted/Informed assignment out per decision
  object. Also `/decisions` Step 6, taking the Step 5 recommendation as the
  decision to assign rights for. Not for diagnosing why authority is unclear
  in the first place (`corporate-misalignment-finder`), recording the bet
  once rights are assigned (`decision-journal`), or converging without any
  explicit authority at all (`focal-point-finder`).
---

# Assign clear decision rights with DAVCI

## Step 1 — Take the decision and split into objects

Get the situation, the deadline, the decision type, the people involved, and any risk domains (security, legal, privacy, brand, compliance). Split into 1–5 crisp decision objects — different outcomes, deadlines, owners, or vetoes mean separate objects; a sentence with two verbs ("select vendor and migrate data") always splits.

Done when every decision object has its own name, and each genuinely differs from the others in outcome, deadline, owner, or veto.

## Step 2 — Assign D and A per object

For each object, name exactly one Decider — the person held to account for the outcome, never split across two names. Add an Approver only if the Decider needs air cover for risk, budget, or politics, and never make the Approver the same person as the Decider.

Done when every object has exactly one Decider and, if present, an Approver distinct from them.

## Step 3 — Assign V, C, and I per object

For each risk domain that actually applies (Security, Legal, Privacy, Brand, Compliance), name one Veto holder with a time-boxed window (default 48h) — never more than one holder per domain. Name who has unique information that would change the decision (Consulted, cap 5 — merge by role past that) and who must know or act after (Informed, kept targeted).

Done when every applicable domain has exactly one veto holder and a window, and Consulted is at or under 5.

## Step 4 — Validate, then set deadline and comms

Run the auto-corrects: no Decider named → propose one and confirm before proceeding; multiple veto holders in one domain → pick one, demote the rest to Consulted; no deadline → default by urgency (today+1 Critical, +3 Standard, +10 Low). Then confirm a concrete deadline, an escalation path ("if blocked 24h, escalate to X"), a single checkable success test, and a comms plan (channel + audience + timing).

Done when every object has passed validation and carries a deadline, an escalation name, a checkable success test, and a comms plan.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-davci-{decision-slug}.md`. Never hand-build the path.

The doc holds: each decision object's D/A/V/C/I assignment, deadline, escalation path, success test, and comms plan, plus a ready-to-post decision summary for the Decider.
