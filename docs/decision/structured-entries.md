# Structured decision entries (v1alpha2)

`decision.aiwg.io/v1alpha2` permits portable JSON semantic entries in a definition's `spec.question`, choice option `description`, ordinal `levels`, and truth `trueDescription` / `falseDescription`. The instruction (`question`) must be a nonempty string, object, or array. Criteria may also be `null`. Nested leaves may be JSON strings, finite numbers, booleans, or nulls. Object field names are stable authored names; object insertion order does not affect artifact pins. Arrays retain order. Entry values are passed as JSON values to Jev instructions/criteria and to the tool-free subagent prompt. They are never merged into the transport envelope or used as state, model, artifact pins, credentials, endpoint, acceptance policy, or egress controls.

A definition with any new structured value must have `apiVersion: decision.aiwg.io/v1alpha2`. v1alpha1 continues to accept only its original string fields. The explicit TypeScript converter `convertDecisionDefinitionV1Alpha1` preserves those strings, changes only the API version, and reports old/new digests. Consumers must update ruleset pins when adopting the new definition. There is no implicit upgrade or downgrade. In rollback, keep v1alpha2 artifacts and receipts read-only; use a prior runtime only for previously pinned v1alpha1 work. Never rewrite v1alpha2 data under a v1alpha1 label.

Admission checks run before canonicalization, digesting, or adapter work. Default limits are 256 KiB serialized bytes, depth 32, 4096 total object properties, 4096 array elements per array, 65536 UTF-16 code units per string, 8192 total entries, and 1000 ms admission time. JSON source parsing rejects duplicate keys. Cycles, non-JSON values, symbols, accessors, custom prototypes, sparse arrays, unsafe prototype keys, and nonfinite numbers are rejected. Rejections expose reason codes and counts, not source contents. `parseCompressedDecisionJson` bounds both compressed and decompressed bytes before JSON admission. A backend must advertise `structured-entries` for v1alpha2 definitions and return unsupported capability if it cannot preserve the value.

This representation does not move exact computation, policy enforcement, or semantic correctness into a model. Arithmetic, dates, counting, access control, and downstream action authorization remain deterministic code and policy responsibilities. Structured entries provide a representation option; they carry no claim of improved decision accuracy.

## Cross-issue version ownership

| Contract addition | Required writer version | Reader and rollback behavior |
|---|---|---|
| D02 structured instruction or criterion | v1alpha2 | v1alpha1 strings remain readable; v1alpha2 stays read-only under rollback |
| D07 native batch receipts | v1alpha2 | Reader must preserve batch provenance; never emit it as v1alpha1 |
| D08 acceptance or uncertainty fields | v1alpha2 | Reader must preserve new field semantics; no v1alpha1 reinterpretation |
| D09 calibration pins | v1alpha2 | Reader must preserve pin identity; no in-place rewrite |
| D10 trust projections | v1alpha2 | Reader must preserve projection provenance; no v1alpha1 egress bypass |

Each follow-on issue must add its concrete field fixtures and dual-reader tests when its fields land. This matrix is the writer gate for those changes, not an implementation claim for unfinished fields.
