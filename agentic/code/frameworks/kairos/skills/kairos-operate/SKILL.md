---
name: kairos-operate
namespace: aiwg
platforms: [all]
description: Write promoted edges and make decisions on a Kairos node (create, resolve, intervene, counterfactual, observe) with idempotency keys and receipts (gate OP).
triggers:
  - operate on kairos with receipts
  - kairos resolve decision
  - kairos observe with idempotency key
  - kairos intervene counterfactual
commandHint:
  modelRole: coding
  modelTier: standard
---

# Kairos Operate

## Inputs

Connection record (gate CG passed), the evaluation `evidence_sha256` or approved packet for every edge you write, the pilot plan's writable namespaces, and the decision the host project needs. Rules: `kairos-node-isolation`, `kairos-paper-before-live`, `kairos-provenance-hash`.

## Workflow

1. Load helpers and set the pilot id used in every key: `. "$FW/scripts/kairos-env.sh"; export KAIROS_PILOT_ID=edge-evm-p1`.
2. Idempotency keys name a durable step, never an attempt: `kkey promote <edge_id> <evidence_sha256 first 12>`, `kkey observe <decision_id> <outcome window>`. Write the key into the step's record before the first send and resend it unchanged on retry. Outcomes: `applied` (done now), `replayed` (done earlier, same payload), `idempotency_key_conflict` (same key, different payload: a client bug, stop), `idempotency_key_expired` (older than 24 h: check whether the step took effect, then mint a new key). Keys are per principal and shared by REST, MCP and agent tools.
3. Promote an edge (only with an `auto_promote` evaluation or approved packet). Create missing XTypes, then the vector, through the retry-safe agent-tool route; every call returns `{tool, schema_version, outcome, data, page, error, operation, approval}`, and success means `error` is `null`:

   ```sh
   E=edge-evm.gas-spike.causes.fill-slippage; EV=<evidence_sha256>
   K1=$(kkey xtype edge_evm.market GasSpike)
   ktool '{"tool":"create_xtype","input":{"idempotency_key":"'"$K1"'","name":"GasSpike","namespace":"edge_evm.market","kind":"data"}}' | ksave .aiwg/kairos/decisions promote-$E-xtype-src.json
   K3=$(kkey promote "$E" "${EV:0:12}")
   ktool '{"tool":"create_vector","input":{"idempotency_key":"'"$K3"'","source_id":"<src id>","target_id":"<dst id>","vector_type":"causal","name":"gas_spike_causes_fill_slippage","weight":0.7,"parameters":{"roles":["edge-evm-paper"]},"metadata":{"kfw_edge_id":"'"$E"'","kfw_sign":"positive","kfw_evidence_sha256":"'"$EV"'"}}}' | ksave .aiwg/kairos/decisions promote-$E-vector.json
   ```

   Metadata keys must match `^[a-zA-Z0-9_-]+$`. A strict pg node with an admin-only namespace policy refuses writes without namespace authority (`ACCESS.authorization_denied`); that is policy, not a bug.
4. Decide through Kairos and keep the receipt. Resolve over MCP or REST (same order; neither records feedback). Always send the operational roles and the as-of `timestamp`, and never the `kairos-candidate` role:

   ```sh
   D=dec-20260926-0001
   kmcp '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kairos_resolve","arguments":{"source_id":"<src id>","context":{"roles":["edge-evm-paper"],"timestamp":"2026-09-26T12:00:00Z"}}}}' | ksave .aiwg/kairos/decisions $D.resolve.json
   kpost /api/v1/causal/intervene '{"variable_id":"<src id>","value":1.0,"context":{"dimensions":{"roles":["edge-evm-paper"]}}}' | ksave .aiwg/kairos/decisions $D.intervene.json
   kpost /api/v1/causal/counterfactual '{"observation":{"<src id>":1.0,"<dst id>":0.4},"intervention":{"<src id>":0.0},"context":{"dimensions":{"roles":["edge-evm-paper"]}}}' | ksave .aiwg/kairos/decisions $D.counterfactual.json
   ```

   MCP tool results are `CallToolResult`: read `result.structuredContent` (the same envelope) and `result.isError`. Causal routes never change the store.
5. Write the decision receipt `.aiwg/kairos/decisions/$D.json`: `schema: "kairos_decision_receipt/v1"`, `recorded_at`, `decision_id`, `mode` (`paper` unless an OP packet has `human_go_signoff: true`; then `live` with `signoff_packet` and its sha256), the intended action and size, each request with its response path and sha256, `node {url, version}`, `as_of`, and `store_revision: {"absent": "not_in_resolve_response"}` (gap C2). Note an empty `trace` (gap C1) rather than inventing a trace.
6. Teach adaptive edges only from real outcomes, as admin, with a key bound to the decision and outcome window:

   ```sh
   KO=$(kkey observe "$D" 2026-09-26T13)
   kmcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"kairos_observe","arguments":{"idempotency_key":"'"$KO"'","vector_id":"<adaptive vector id>","signal":0.8,"context":{"roles":["edge-evm-paper"]}}}}' | ksave .aiwg/kairos/observations $D.observe.json
   ```

   The receipt carries `weight`, `learning_rule` (`ema-phi-v1`: new = 0.618·old + 0.382·signal, below 0.382 becomes 0), `learning_digest` and `store_revision` (absent when a namespace policy is configured). One observation can open or close a route because admission is a hard 0.618 line on a point estimate (gap C4); say so in the pilot report when it happens.
7. Demote (`auto_demote` or a reject on an active edge) by re-gating the vector to a role nobody sends, with optimistic concurrency, and record why: `kcurl -X PUT "$KAIROS_URL/api/v1/vectors/<id>" -H 'Content-Type: application/json' -d '{..., "parameters":{"roles":["kairos-retired"]},"expected_fingerprint":"<fingerprint from GET>"}'`.
8. Anything that contradicts the docs (status codes, envelope fields, refusals, a candidate or retired vector admitted under operational roles) goes to `kairos-conformance-prober` as a finding with the saved response.

## Outputs

Promotion responses, decision receipts, observation receipts, all hashed. Gate OP passes when every decision in the period has a receipt and every live decision has a signed OP packet.

## Continue or hold

Continue paper operation freely. Hold any live-money, signing or capital step until an OP packet is signed (`kairos-review-packet`). On `unavailable` errors retry with the same key after `retry.after_ms`; on `unknown` outcomes check state before retrying.
