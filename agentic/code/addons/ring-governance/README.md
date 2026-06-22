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

- Rules for no self-grading, evaluator immutability, governance-boundary protection, and
  memory-is-not-proof.
- Skills for governance corpus inventory, governance escape-hatch audits, and evolution adapter
  review.
- Templates for protected surfaces, criterion sets, evolution adapters, and Fortemi boundaries.
- A governance skeptic agent for adversarial review.

## Non-Goals

- No Ring code is ported in v1.
- No addon command or runtime hook is installed in v1.
- No Fortemi memory output is treated as proof.
- No evolution adapter is considered safe until its evaluator, criteria, policy, and promotion path are
  outside the producer's edit surface.

## Provenance

The addon was generalized from prior governance-harness work, but it does not require a private
report, local archive, or Ring checkout. Any project using this addon should derive its own baseline
from the live `.aiwg/` workspace in the invocation cwd or from an explicitly supplied corpus.
