---
name: kairos-propose-graph
namespace: aiwg
platforms: [all]
description: Propose a context-resolved causal graph for a project domain as hashed Kairos edge proposals, never as admitted edges (gate MB).
triggers:
  - propose a kairos causal graph
  - kairos domain model
  - kairos candidate edges
  - model the domain in kairos
commandHint:
  modelRole: reasoning
  modelTier: standard
---

# Kairos Propose Graph

## Inputs

Pilot plan (approved node types, writable namespaces, datasets with as-of rules), connection record (gate CG passed), existing proposals, and the domain's data. Rules: `kairos-llm-proposes-never-admits`, `kairos-point-in-time`, `kairos-provenance-hash`.

## Workflow

1. Load helpers (see `kairos-connect` step 2): `. "$FW/scripts/kairos-env.sh"`.
2. Hash every input before reading it, and keep the hashes with the proposal:

   ```sh
   node "$FW/scripts/kairos-records.mjs" sha256 datasets/edge_evm/gas-2026-08-11.parquet docs/strategy.md
   ```

3. Look up what already exists instead of inventing ids (read-only; MCP has no list or search tool, so use REST):

   ```sh
   kget '/api/v1/xtypes?namespace=edge_evm.market' | python3 -m json.tool
   kget '/api/v1/resolve?query=GasSpike&threshold=0.5' | python3 -m json.tool
   ```

4. Model nodes and edges in Kairos's terms. An XType has `name`, `namespace`, `kind`. A vector has `vector_type` (`structural` always admitted; `contextual` and `causal` admitted when every parameter matches the request context; `adaptive` when the learned weight is at least 0.618; `behavioral` only through behavioral events). Public resolve context is only `user`, `roles`, `locale`, `timestamp`, exact or any-of match, with no time windows. Encode regimes or pipelines as roles (for example `edge-evm-paper`). Stored weights are non-negative and values below 0.382 collapse to 0, so the effect sign lives in the proposal, not in a weight. Feedback is a lagged edge or node, never a cycle; check acyclicity before writing any proposal set:

   ```sh
   kpost /api/v1/causal/validate-dag '{"edges":{"GasSpike":["FillSlippage"],"FillSlippage":["FollowerPnL"]}}'
   # {"valid": true, "message": null} or HTTP 400 naming the cycle
   ```

5. Write one proposal per proposer per edge to `.aiwg/kairos/proposals/<edge_id>.<proposer_id>.json` with schema `kairos_edge_proposal/v1` (`schemas/edge-proposal.schema.json`; example `examples/edge-proposal.example.json`): `edge_id`, `proposer {id, family, kind, model, method_ref}`, `source`/`target` `{name, namespace, kind}`, `vector_type`, `sign`, `parameters`, `lag`, `mechanism`, `falsifier`, `sources [{ref, sha256, as_of}]`, `status: "candidate"`, and the escalation flags `new_node_type`, `touches_live_money`, `policy_touching`, `signing_or_capital_policy`. A node type not listed in the pilot plan sets `new_node_type: true`. Confidence is text; never a weight.
6. Ask independent proposer families for the same edge list: a second LLM vendor, a statistical screen (for example a HAC-robust Granger test on the training window only), or a domain rule written by a person. Record a family that was asked and declined, so gate EA-G2 counts it as consulted.
7. Validate every proposal. Gate MB passes when all proposals validate and every node type is approved or flagged:

   ```sh
   node "$FW/scripts/kairos-records.mjs" validate .aiwg/kairos/proposals/*.json
   ```

8. Optional candidate mirror, only when the pilot plan enables it: write the candidate to the node gated on a role no operational request sends, so it is visible in the console but never admitted during operate:

   ```sh
   export KAIROS_PILOT_ID=edge-evm-p1
   KEY=$(kkey candidate-mirror edge-evm.gas-spike.causes.fill-slippage)
   ktool '{"tool":"create_vector","input":{"idempotency_key":"'"$KEY"'","source_id":"<GasSpike id>","target_id":"<FillSlippage id>","vector_type":"causal","name":"gas_spike_causes_fill_slippage_candidate","weight":0.5,"parameters":{"roles":["kairos-candidate"]},"metadata":{"kfw_status":"candidate","kfw_edge_id":"edge-evm.gas-spike.causes.fill-slippage"}}}'
   ```

   Record `mirror {vector_id, idempotency_key}` on the proposal. Resolve and intervene under operational roles must not return it; if they do, that is a conformance finding.

## Outputs

Validated proposals with source hashes, the acyclicity check, and the list of consulted proposer families per edge. No admitted edge.

## Continue or hold

Continue to `kairos-validate-evidence`. Hold a proposal set that is cyclic, reads data after its as-of time, or lacks hashes. Do not call `create_vector` outside the role-gated mirror; admission happens only through `kairos-operate` after the gates.
