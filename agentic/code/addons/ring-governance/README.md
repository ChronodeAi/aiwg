# Ring Governance

Ring Governance is a content-only AIWG addon seed mined from the Ring workspace. It captures the
portable governance lessons without copying Ring's Python implementation.

## Purpose

This addon helps review systems where an agent, optimizer, harness, or evolution loop proposes changes
that could affect its own evaluation path.

The core rule is simple:

> An untrusted producer may propose work, but it must not edit, judge, promote, or redefine the
> governance surface that decides whether the work is accepted.

## V1 Contents

- Rules for no self-grading, evaluator immutability, governance-boundary protection, and
  memory-is-not-proof.
- Skills for Ring corpus mining, governance escape-hatch audits, and evolution adapter review.
- Templates for protected surfaces, criterion sets, evolution adapters, and Fortemi boundaries.
- A governance skeptic agent for adversarial review.

## Non-Goals

- No Ring code is ported in v1.
- No addon command or runtime hook is installed in v1.
- No Fortemi memory output is treated as proof.
- No evolution adapter is considered safe until its evaluator, criteria, policy, and promotion path are
  outside the producer's edit surface.

## Source Baseline

The first local baseline is:

`.aiwg/reports/ring-mining-baseline-2026-06-22.md`

Use it as the starting inventory before adding executable behavior.
