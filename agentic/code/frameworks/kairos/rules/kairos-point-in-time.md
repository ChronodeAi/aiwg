---
id: kairos-point-in-time
name: Kairos Point-in-Time Evidence
description: Evidence for a Kairos edge uses only data available at its as-of time, referenced with a hash.
enforcement: critical
triggers:
  - "look-ahead bias"
  - "which dataset version was used"
  - "walk-forward evaluation"
  - "as-of data snapshot"
---

# Kairos: Point-in-Time Evidence

## Scope

Applies to proposals, evidence bundles, gate evaluations, review packets and operate-phase decisions.

## Requirements

- Reference every dataset as-of: `{ref, as_of (UTC), sha256}`. The hash is of the exact bytes read (file, export or query result). A path without a hash is not evidence.
- No look-ahead. A training or fitting window ends strictly before its test window starts. Features at decision time t use only data whose availability time is at or before t, including publication and indexing lag. Block and regime labels are computed from data available at the time, not fitted on the whole history.
- Evaluation data is disjoint from proposal sources. A snapshot an LLM or statistical proposer read cannot be used to confirm that proposal; `kairos-gates.mjs` fails EA-G5 when a walk-forward snapshot hash appears in the proposal's source hashes.
- Walk-forward windows are ordered in time and evaluated in sequence; no window is re-run after seeing a later one without recording the re-run.
- Operate-phase requests record the `timestamp` context field (ISO 8601; `src/server/models/resolution.py`) or the as-of time in the decision receipt, so a decision can be replayed against the same state.
- Kairos resolve responses carry no store revision today (known gap C2). Record the observation receipt's `store_revision` when one exists and `{"absent": "not_in_resolve_response"}` otherwise; never invent one.

## Required response

When a dataset lacks an as-of or hash, stop using it for gates, hash it or obtain a hashed snapshot, and record the change. A detected look-ahead invalidates the affected gate evaluations; re-run them and note the invalidation in the evidence directory.
