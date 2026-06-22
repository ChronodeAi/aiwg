# Memory Is Not Proof

**Enforcement Level**: HIGH
**Scope**: Semantic memory, Fortemi recall, notes, summaries, reflections, generated reports,
archive notes, retrieval results, and prior-session context.
**Addon**: ring-governance
**Status**: DRAFT

## Rule

Semantic memory, Fortemi recall, summaries, reflections, prior reports, and archive notes may inform
context but must not decide correctness, acceptance, promotion, or arming.

## Allowed Uses

- Recall prior context, candidate leads, related decisions, and likely evidence locations.
- Preserve provenance pointers and analyst notes.
- Suggest hypotheses for review.

## Forbidden Uses

- Treating a remembered claim as proof that work passed.
- Treating a generated summary as primary evidence.
- Re-retaining recalled content as fresh evidence without explicit review.
- Failing unrelated correctness paths because memory capture, retrieval, or summarization failed.

## Enforcement Guidance

- Treat memory as advisory input.
- Require primary evidence or executable verification for proof.
- Mark recalled context so it cannot be re-retained as fresh evidence without review.
- Keep memory outage or capture failure from failing unrelated correctness paths.
- Never accept a claim only because it appears in a previous note, reflection, report, or generated summary.
- Prefer citations to live files, commits, test output, signed verdicts, or independently reproducible
  checks over citations to memory records.

## Failure Smell

If a system can pass because memory says it passed, the memory layer has become a verifier. That is outside
the allowed boundary.
