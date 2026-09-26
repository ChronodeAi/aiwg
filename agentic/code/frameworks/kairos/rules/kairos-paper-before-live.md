---
id: kairos-paper-before-live
name: Kairos Paper Before Live
description: No live money, order signing or capital movement from a Kairos-backed decision without a recorded human sign-off.
enforcement: critical
triggers:
  - "go live with kairos decisions"
  - "sign the transaction"
  - "move from paper to live"
  - "real money trade"
---

# Kairos: Paper Before Live

## Scope

Applies to operate-phase decisions that could move funds, sign transactions, place orders, change capital allocation or change a signing or risk policy, including through another project's pipeline.

## Requirements

- Default mode is paper. A decision receipt records `mode: paper` unless a live sign-off record exists for that exact decision policy.
- Going live needs a review packet with `gate: OP`, `recommendation: GO`, `human_go_signoff: true` and a `decision` signed by a named human, plus the host project's own release gate. An agent never sets `human_go_signoff`.
- The framework holds no keys and never signs. It never reads wallet files, private keys, seed phrases or signing endpoints, and never asks for them.
- Edges that touch live money or policy, and signing or capital policy changes, always escalate to a human even when every evidence gate passes (see `kairos-validate-evidence`).
- A paper decision records what live would have done: the intended action, size and the Kairos receipts that justified it, so the paper-to-live comparison is possible.
- Randomized paper actions used as interventional evidence (gate EA-G6) stay paper actions. Their assignment seed is hashed and recorded before outcomes are seen.

## Required response

When a request would cross into live effects without the sign-off, stop that step, write the decision as paper, and render an OP review packet stating the exact action and authority needed.
