# Invocation receipt state and durable store

The dispatcher acquires a receipt with an atomic create-if-absent operation before it calls an adapter. A receipt binds the invocation ID, project ID, canonical input, ordered definition pins, ruleset and binding pins, and optional policy and calibration pins. Reuse requires an exact fingerprint match. A changed invocation payload fails `replay-mismatch` before dispatch.

| Current state | Allowed next states | Meaning |
|---|---|---|
| acquired | dispatched, observation-received, composed, failed, execution-uncertain | Ownership exists; no adapter call has started. |
| dispatched | remote-handle-known, observation-received, execution-uncertain | Adapter call may have reached a remote executor. |
| remote-handle-known | observation-received, execution-uncertain | Opaque provider or worker handle is durable. |
| observation-received | observation-received, dispatched, composed, failed, execution-uncertain | One adapter observation has returned; completed evaluations are checkpointed before another attempt. |
| composed | completed, failed | Ruleset composition is finished and awaiting terminal persistence. |
| completed, failed, execution-uncertain | none | Terminal receipts cannot be changed. |

Each transition uses a revision compare-and-swap. A version conflict or failed write returns `persistence-error`, and the evaluator never returns a composed action outcome after that error. The file store serializes operations with a per-invocation exclusive lock, writes a temporary file, synchronizes it, renames it, and synchronizes the directory. It requires a caller-supplied 32-byte or longer integrity key and authenticates every record with HMAC-SHA-256. The key belongs outside the receipt directory. Authorization is checked on each acquire, read, CAS, and wait. A modified record, cross-project substitution, invalid schema, or impossible transition fails closed.

Receipts record acquisition, update, and completion epoch milliseconds. A completed receipt is immutable, so repeated reads return the original timestamps alongside the exact result, model and attempt lineage, usage, and outcome. The public `RulesetResult` schema remains unchanged; timestamps are private receipt metadata. The file store has no separate index: the SHA-256 invocation filename is its lookup mapping, and a valid authenticated record copied under another invocation filename is rejected on read.

An incomplete dispatched receipt is never retried blindly. A waiting caller first waits for the owner to persist a terminal result. If the wait ends without one, it checks for a remote handle and invokes a supplied reconciliation callback. A successful observation resumes from checkpointed evaluations and composes with the remaining evaluations. An unknown or unsuccessful observation records `execution-uncertain`. This deliberately does not promise exactly-once remote billing. Production worker transports should report their opaque handle through `onHandle` as soon as they obtain it; the runtime persists the handle before trusting a terminal observation.

The old `decision-receipt/v1` shape has no ownership or revision proof and is rejected by the v2 reader. Historical completed receipts require an explicit, reviewed migration that verifies their original pins and result before converting them. No automatic reinterpretation is performed.

The shared store conformance tests run acquisition, stale CAS, project isolation, evaluator race, replay, and uncertain restart cases against both memory and file stores. The durable-specific tests race two processes, kill the owner process at each receipt state, restart a fresh store, and verify exact state and revision. Separate tests cover record tampering, invocation filename substitution, revoked authorization before reconciliation, and final persistence failure.
