---
name: kairos-validate-evidence
namespace: aiwg
platforms: [all]
description: Run the client-side evidence admission gates on Kairos candidate edges and decide auto-promote, hold or escalate (gate EA).
triggers:
  - validate kairos edge evidence
  - kairos evidence gates
  - admit a kairos edge
  - kairos edge admission
commandHint:
  modelRole: reasoning
  modelTier: standard
---

# Kairos Validate Evidence

## What Kairos enforces today, and what this skill enforces

Kairos 2.1.1 enforces none of the evidence gates below. ADR-0034 accepted only unit U34-A, "an LLM may propose an edge; it may never admit one" (`.aiwg/architecture/adr-0034-causal-evidence-state-and-admission.md:40,122`). The gate stack (U34-C) is Proposed and waits for ADR-0035 at L2 and enough intervention volume (`:128`), and edge status `candidate`/`active` (U34-B) does not exist yet (`:127`). What the node does enforce: adaptive edges are admitted at weight ≥ 0.618 on a point estimate (`src/neural/resolver.py:29-34`, gap C4); causal edges are admitted on parameter match unless blocked by an intervention (`src/causal/resolver.py:6-18`); weights below 0.382 collapse to 0 on create (`src/server/models/vector.py:54-72`). A vector written to the node is live for resolution. So this framework runs the gates client-side, before any write, and records "gate stack not enforced by the node" once per pilot as a finding for `kairos-feedback` (kind `friction`, citing ADR-0034 line 128).

## Gates

| Gate | Passes when (defaults in `config/gate-policy.json`) |
|---|---|
| EA-G1 naive-baseline margin | out-of-sample metric beats the naive baseline (no-edge or persistence model) by more than `min_margin` |
| EA-G2 proposer agreement | at least 3 proposer families consulted and at least 2 distinct families propose the edge with the same sign; two models from one vendor are one family |
| EA-G3 statistic with FDR control | the statistic is allowed for the data's provenance (observational: block permutation, block bootstrap, HAC, placebo refutation; interventional: randomization, permutation, Welch) and its p-value is inside the Benjamini-Hochberg cut at q = 0.05 over every hypothesis tested in the batch |
| EA-G4 block and regime stability | at least 4 time blocks, at least 80 % share the proposed sign, and no regime with 2 or more blocks flips sign by majority |
| EA-G5 point-in-time walk-forward | at least 3 ordered windows, each with `train_end` before `test_start`, a hashed snapshot not read by any proposer, a win over the baseline in at least 67 % of windows, and a positive mean margin |
| EA-G6 interventional confirmation | when randomized paper actions exist: at least 20 units per arm, p ≤ 0.05, and the effect sign matches; `not_available` otherwise (does not block, recorded as a gap: observation receipts carry no `propensity` or `randomness_key`, API.md:796-797) |
| EA-G7 K-consecutive hysteresis | the edge passed every other required gate in the last K = 3 evaluations, including this one |

ADR-0034 also lists a scale probe and non-circular falsification. EA-G5's disjointness check covers circularity; the scale probe is not implemented and is listed as such in the pilot report. The thresholds are calibration starting points (ADR-0034 calls `K_HYST` a placeholder); change them only in the project's copy of the policy, with a reason, which changes `contract_sha256`.

## Workflow

1. Copy the policy once per pilot and hash it: `cp "$FW/config/gate-policy.json" .aiwg/kairos/reports/gate-policy.json && node "$FW/scripts/kairos-records.mjs" sha256 .aiwg/kairos/reports/gate-policy.json`.
2. Build one evidence bundle per evaluation window at `.aiwg/kairos/evidence/<window>/bundle.json` (format: `examples/evidence-bundle.example.json`). Per edge: `edge_id`, `sign`, `current_status` (`none`, `candidate`, `active`), `active_sign` for active edges, escalation flags copied from the proposals, `proposal_sources_sha256` (every source hash from every proposal), `baseline_margin {metric, higher_is_better, model, baseline}`, `proposers [{id, family, proposes, sign}]` including families that declined, `statistic {name, data_provenance, p_value, effect}`, `blocks [{block_id, regime, effect}]`, `walk_forward {higher_is_better, windows [{train_end, test_start, test_end, snapshot_sha256, model, baseline}]}`, `interventional {available, design, n_treated, n_control, effect, p_value, assignment_seed_sha256}`, and `history` (the `history_entry` values of earlier evaluations). Put every tested hypothesis in the bundle, or set `fdr_family_size` to the full count, so the FDR cut is honest.
3. Evaluate and keep the output:

   ```sh
   node "$FW/scripts/kairos-gates.mjs" .aiwg/kairos/evidence/<window>/bundle.json \
     --policy .aiwg/kairos/reports/gate-policy.json > .aiwg/kairos/evidence/<window>/evaluation.json
   python3 -c 'import json; [print(e["edge_id"], e["decision"], e["escalation_reasons"]) for e in json.load(open(".aiwg/kairos/evidence/<window>/evaluation.json"))["edges"]]'
   ```

4. Act on each decision:
   - `auto_promote`: hand the edge and the evaluation's `evidence_sha256` to `kairos-operate` (create the vector). No human.
   - `hold_candidate`, `keep_active`: nothing to do; the history entry carries to the next window.
   - `auto_demote`: an active edge failed K evaluations in a row; `kairos-operate` removes it from action and records why.
   - `escalate`: build a packet with `kairos-review-packet`. Escalation reasons are exactly: `live_money_or_policy`, `signing_or_capital_policy` and `new_node_type` (raised only when the evidence would otherwise promote the edge), `gate_disagreement` (the statistic or walk-forward disagrees with the interventional result), and `sign_flip_on_active_edge`.
5. Append each edge's `history_entry` to the next window's bundle. Never re-run a window with changed data without recording why.

## Outputs

Bundles, evaluations (each with `evidence_sha256`, `policy_sha256` and `kairos_enforcement`), and the list of promotions, demotions and escalations.

## Continue or hold

Gate EA passes when every edge on the node traces to an `auto_promote` evaluation or an approved packet. Never edit a bundle to make an edge pass, never drop failing hypotheses from the FDR family, and never promote on LLM agreement alone.
