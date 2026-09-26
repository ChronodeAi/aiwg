# Measure the pilot

Per milestone record: proposals and proposer families; admitted edges (automatic and human); escalations by reason; review minutes in total and per admitted edge; calibration labels and how often humans confirmed the recommendation; decisions made through Kairos with receipts; observations applied and replayed; paper outcome against the naive baseline; conformance pass rate at start and end; findings by kind, severity and state, with issue numbers.

`node "$FW/scripts/kairos-records.mjs" status .aiwg/kairos` computes the counts it can read from files. Record unknown values as unknown. Compare against the previous milestone only when the gate policy hash and node version are unchanged, or say what changed.

Targets are operating aims, not claims: zero edges on the node without an evaluation or packet, zero live decisions without an OP sign-off, falling review minutes per admitted edge as calibration labels accumulate, and every finding either filed, deduplicated or held with its missing evidence named.
