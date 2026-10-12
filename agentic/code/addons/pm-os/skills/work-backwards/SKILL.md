---
name: work-backwards
description: >-
  Use when one assumption needs the cheapest evidence that could settle it before
  anything gets built — a "We believe that…" statement in, five candidate signals
  and one chosen signal out with a method, a timebox, and a quantified pass
  threshold. Also `/assumptions` Step 3, run once per critical assumption. Not for
  generating the assumption set (`product-assumptions`), ranking which to test
  first (`risky-assumptions`), or designing a powered experiment once a signal
  justifies one (`experiment-design`).
---

# Work backwards from one assumption to its cheapest signal

## Step 1 — Take the assumption and its context

Take one assumption, stated as "We believe that…". Gather whatever context exists: segment (consumer, SMB, mid-market, enterprise, gov/healthcare), the function running the test, product stage (idea, prototype, alpha, beta), constraints (compliance, data sensitivity, procurement, unavailable channels), assets on hand (customer list, design partners, sandbox, analytics, ad budget), and the time and money available. Infer what is missing and say so.

Done when exactly one assumption is in scope, and every context field is either stated or explicitly inferred.

## Step 2 — Classify the lens

Name the assumption's primary lens — desirability (intent, willingness to pay), feasibility (technical or operational), viability (economics), or usability (interaction). The lens decides which signal families are even worth listing.

Done when one lens is named, with one sentence on why the others do not fit.

## Step 3 — Brainstorm at least five signals

List five or more distinct signals, one line each: signal name, what would count as positive evidence, how to obtain it quickly, why it suits this context.

Suitability is a hard filter, not a preference:

- **Enterprise or B2B under procurement or security gates** — economic-buyer interviews, design-partner LOIs, security-questionnaire dry runs, sandbox demos, ROI calculators, reference checks, API mock evaluations. Tactics that route around the buying process — smoke tests, fake doors, consumer ad funnels — do not belong here.
- **SMB SaaS** — discovery calls, lightweight trials, website offer tests, POC requests, email-list tests, existing analytics; modest paid experiments are fair.
- **Consumer** — ad-driven intent, waitlist conversion, community polls, preorders, competitor usage proxies.
- **Regulated (health, finance)** — standards mapping, SME review, regulatory preflight, de-identified or synthetic data checks. Sensitive data stays uncollected until approvals exist.
- **Feasibility assumptions** — engineering spikes, benchmark reproductions, vendor evaluations, data-quality audits, ahead of anything user-facing.

Across every context: no scraping personal data, no deception, no test that needs an approval you do not hold.

Done when five or more signals are listed, each carrying all four fields, and each one passes the suitability filter for the Step 1 segment and constraints.

## Step 4 — Choose one and specify it

Pick the single best signal and specify it: description, step-by-step method, why it suits the segment and stage, earliest stage it works at, participants and sample size, timebox and cost, quantified success threshold, data captured, risks and mitigations, and the one next move if the signal comes back positive.

The chosen signal has to be early (available at idea or prototype stage), cheap (leans on assets already in hand), attributable (moves uncertainty on *this* assumption, not the product in general), and decisive (a number decides pass or fail).

Done when all ten fields are filled, the threshold is a number rather than a direction, and the signals you rejected are named with the reason.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-signal-{assumption-slug}.md`. Never hand-build the path.

The doc holds: the assumption and its lens, the five-plus candidate signals, the chosen signal fully specified, and the rejected options with reasons.
