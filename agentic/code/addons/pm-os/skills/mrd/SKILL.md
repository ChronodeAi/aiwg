---
name: mrd
description: >-
  Use when a market opportunity needs a Market Requirements Document — TAM,
  SAM and SOM each carrying a source link or a marked assumption, Porter's
  Five Forces, buyer behaviour, and the market requirements that fall out of
  them — built through a question-at-a-time interview rather than a one-shot
  draft. Not for a feature-level product requirements document (`prd-draft`),
  redefining the market through Jobs-to-be-Done (`jtbd-market-canvas`),
  pointing existing company strengths at one industry (`industry-strategy`),
  or profiling named competitors one by one (`netmba-competitor-analysis`).
---

# Build a Market Requirements Document

An MRD earns its length by being decision-ready: someone reads it and knows whether to enter the market and on what terms. It gets there by sizing the market with sources rather than adjectives, and by deriving requirements from the analysis instead of asserting them alongside it.

Interview first. Draft nothing until the user says they're ready.

## Step 1 — Interview

Ask one question at a time, adapting each follow-up to the last answer:

1. What market or industry are you exploring?
2. What is the core problem or unmet need in it?
3. Who is the target user or buyer?
4. What are they doing about it today — competitors, workarounds, DIY?
5. What is your company's role, vision or advantage here?
6. What external forces shape this market — trends, regulation, technology, constraints?

Done when all six are answered and the user has said they're ready to draft.

## Step 2 — Size the market

Estimate TAM (total demand, top-down), SAM (TAM constrained to reachable regions and segments), and SOM (realistic 1–3 year share after competition, GTM and capacity).

Each figure carries a source link, a timeframe, and a one-line method note. Where the data doesn't exist, ask for a narrowing input (geography, vertical, pricing model) or mark the figure an assumption in the text — never present an unsourced number as a finding.

Done when TAM, SAM and SOM each carry either a source link with timeframe and method, or an explicit assumption marker.

## Step 3 — Analyse the landscape and the forces

Map the ecosystem: key segments, competitors and their positioning, growth rate, and the regulatory, technical and social forces acting on it. Then run Porter's Five Forces — supplier power, buyer power, rivalry, substitutes, barriers to entry — and state which force binds hardest.

Done when all five forces have a verdict and one is named as the binding constraint.

## Step 4 — Derive the requirements

Decompose the problem, rate each part by severity, frequency and impact, and assess where current solutions fail. Translate that into market requirements — functional, technical and regulatory — each traceable to a specific gap found in Steps 2 and 3.

Done when every requirement names the gap it answers, and every high-severity gap has at least one requirement.

## Step 5 — Draft the MRD

Assemble in this order, pausing after each section for feedback: Executive Summary · Market Overview · Competitive Landscape · Customer Analysis · Problem & Solution Requirements · Business Model & Financials · Implementation & GTM Roadmap.

Plain, active language. Bullets and tables where they help. Assumptions, risks and open questions called out rather than smoothed over.

Done when every section is written, every quantitative claim links to a source or an assumption marker, and the open questions are listed at the end.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-mrd-{market-slug}.md`. Never hand-build the path.

The doc holds: the seven MRD sections, the sizing with sources, the Five Forces verdict, and the open questions.
