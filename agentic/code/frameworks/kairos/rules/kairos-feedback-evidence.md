---
id: kairos-feedback-evidence
name: Kairos Feedback Evidence
description: A Kairos finding is filed only with the exact command, its output, a doc citation file:line and expected versus observed.
enforcement: high
triggers:
  - "file a kairos issue"
  - "report a kairos bug"
  - "kairos does not match its docs"
  - "conformance finding"
---

# Kairos: Feedback Evidence

## Scope

Applies to every finding recorded under `.aiwg/kairos/findings/` and every issue or comment sent to `ChronodeAi/kairos`.

## Requirements

- A finding records: the exact command or request (token as `$KAIROS_API_TOKEN`, never its value), the raw output excerpt and its sha256, the doc citation as `file:line` at a named tag or commit, the expected behavior quoted or paraphrased from that citation, and the observed behavior. Node version and profile come from the recorded `/api/v1/meta`.
- `node <framework>/scripts/kairos-records.mjs fileable <finding.json>` must print `OK` before filing. It fails on a missing field, a non-open status, a fingerprint mismatch, identical expected and observed, or a credential in the record.
- Reproduce on the configured node before filing. A single observation of a timing-dependent failure is recorded as such.
- Separate fact from inference. Anything not observed is marked `[INFERENCE]` in the issue body.
- Findings that reproduce a known gap (for example C1 empty resolve trace, C2 missing store revision in resolve, C4 hard 0.618 adaptive threshold on a point estimate, C6 LLM-derived causal weights written by `src/causal/live_providers.py:276-300`) carry `known_gap` and are commented on the existing issue, not filed again.
- File only on `ChronodeAi/kairos`. Never on a fork, mirror, local clone or another tracker.

## Required response

If evidence is incomplete, keep the finding `open`, list the missing fields, and collect them. Do not paraphrase a failure into an issue without its command and output.
