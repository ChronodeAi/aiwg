# D29 public development demos

These fixtures are **PUBLIC DEVELOPMENT DEMOS**, using seed `d29-study-v3`.
The complete corpus and gold are committed for development review and offline
regression tests. They are not a private holdout, paid-run approval, live model
result or completed human review.

The collector rejects `d29-study-v1`, `d29-study-v2`, `d29-study-v3` and the
pinned canonical digests of the committed demo corpora. A paid run requires a
fresh private operator seed, never printed or committed, new development review
and separately anchored approvals. See the
[private preparation runbook](../../../../docs/decision/d29-heldout-study.md#prepare-and-approve-the-private-calibration-phase).

The `only-listens` variant now explicitly excludes all other port use.
`configured` and `configured-mid` explicitly state current port use; the latter
keeps its injection bracket inside the sentence. Variant IDs, gold labels,
split memberships, the v1 registry and the frozen baseline are unchanged.

`V2-09` in `test/unit/decision/d29-study.test.mjs` re-derives every JSON file
from source. After regeneration, refresh the fixture provenance registry and
the canonical corpus exclusion in `src/decision/heldout/contract.ts`; retain
previous public corpus exclusions. `PUBLIC-02` verifies the committed corpus
is refused by digest. The fixture registry records file-byte digests, while
the collector and dry-run use canonical JSON digests.
