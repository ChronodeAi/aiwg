# Ring Governance

Ring Governance is a content-only AIWG addon for reviewing governance boundaries in agent,
optimizer, harness, and evolution-loop workflows. It was initially seeded from Ring workspace
lessons, but its skills operate on the caller's current live workspace or an explicitly supplied
corpus.

## Purpose

This addon helps review systems where an agent, optimizer, harness, or evolution loop proposes changes
that could affect its own evaluation path.

The core rule is simple:

> An untrusted producer may propose work, but it must not edit, judge, promote, or redefine the
> governance surface that decides whether the work is accepted.

## V1 Contents

- Rules for no self-grading, evaluator immutability, governance-boundary protection,
  judge-validation discipline, and memory-is-not-proof.
- A validation protocol for LLM-as-judge surfaces: exact-match agreement is not enough; require
  chance-corrected agreement, repeatability, benchmark transfer checks, and bias audits before an
  LLM judge can be treated as a governance authority.
- Skills for governance corpus inventory, governance escape-hatch audits, and evolution adapter
  review.
- Templates for protected surfaces, criterion sets, judge validation, evolution adapters, and Fortemi
  boundaries.
- A governance skeptic agent for adversarial review.

## Non-Goals

- No Ring code is ported in v1.
- No addon command or runtime hook is installed in v1.
- No Fortemi memory output is treated as proof.
- No LLM-as-judge output is treated as production proof until its validation package is current,
  protected from the producer, and bound to the exact task family it judges.
- No evolution adapter is considered safe until its evaluator, criteria, policy, and promotion path are
  outside the producer's edit surface.

## Provenance

The addon was generalized from prior governance-harness work, but it does not require a private
report, local archive, or Ring checkout. Any project using this addon should derive its own baseline
from the live `.aiwg/` workspace in the invocation cwd or from an explicitly supplied corpus.

## Research Note

The judge-validation rule incorporates the 2026 arXiv paper "Reliability without Validity" as a
governance warning: LLM judges can be internally consistent while still biased or invalid for the
decision being made. Treat reliability as one required signal, not as proof of validity.
