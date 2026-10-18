---
name: Roadmap Item
about: Propose roadmap work tied to a bet, with testable acceptance criteria
title: 'feat(<area>): <outcome in one line>'
labels: ['enhancement']
---

<!-- Add one bet:* label if this serves a roadmap bet (see docs/planning/ROADMAP.md),
     plus a priority:* label. Keep customer or client names out of the text. -->

## Problem

What is broken or missing today, and what does it cost (time, tokens, risk, rework)?

## Users

Who hits this (operator, agent, reviewer, maintainer), and in which workflow?

## Proposal

The smallest change that solves the problem. Name commands, schemas, files or interfaces.

## Acceptance criteria

Each item must be checkable by a test, a command, or a recorded measurement.

- [ ] <observable behavior, with the command or test that proves it>
- [ ] <failure or edge case that must be rejected>
- [ ] <measurement with a threshold, if the goal is cost or performance>
- [ ] Tests cover the happy path and the rejection cases
- [ ] Docs and CHANGELOG updated

## Evidence

Why we believe this matters: measurements, failing runs, user reports, market or standards signal. Link issues, PRs or reports.

## Out of scope

What this explicitly does not cover.

## Bet and milestone

- Bet: <bet:... label or "none">
- Target milestone: <calver release, e.g. 2026.10.x, or "unscheduled">
- Depends on: #
