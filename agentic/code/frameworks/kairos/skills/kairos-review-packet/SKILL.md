---
name: kairos-review-packet
namespace: aiwg
platforms: [all]
description: Build a Kairos review packet for an escalated edge, render it for a human, and record the decision as a calibration label.
triggers:
  - kairos review packet
  - review an escalated kairos edge
  - record a kairos edge decision
  - kairos human sign-off
commandHint:
  modelRole: efficiency
  modelTier: economy
---

# Kairos Review Packet

## Inputs

The gate evaluation that escalated the edge, the edge's proposals, the evidence bundle's `data_snapshot`, the connection record, and the exact node write that approval would cause. Schema: `schemas/review-packet.schema.json` (`kairos_review_packet/v1`); example `examples/review-packet.example.json`.

## Workflow

1. Build `.aiwg/kairos/packets/<packet_id>.json`, with `packet_id` `KP-<YYYYMMDD>-<edge slug>`:
   - Gate-record fields, same meaning as the AIWG gate record: `schema`, `recorded_at` (UTC), `gate` (`EA` for edges, `OP` for going live), `status` (`ESCALATED`, or `PASS`/`FAIL` for audit packets), `recommendation` (`GO`, `NO-GO`, `DEFER`), `human_go_signoff: false`, `contract` (the project's gate policy path) and `contract_sha256` (the evaluation's `policy_sha256`).
   - `escalation_reasons` from the evaluation.
   - `subject`: edge id, source and target `{name, namespace, kind, xtype_id}`, vector type, sign, parameters, `gates_action`, `touches_live_money`, current and proposed status, Kairos vector id if one exists.
   - `proposers` with each proposal file's sha256; `sources` and `data_snapshot` from the bundle.
   - `gates`: copy the evaluation's gate objects unchanged (`id, name, status, pass, value, threshold, detail, enforced_by`).
   - `diff.before` / `diff.after`: the node state before and the exact `create_vector` input after, without the idempotency key.
   - `impact`: one paragraph on what decisions change, and whether it stays paper.
   - `kairos {node_url, version, meta_sha256, store_revision}` from the connection record. Resolve responses carry no store revision (gap C2), so use `{"absent": "not_in_resolve_response"}` unless an observation receipt supplied `{instance_id, recorded_seq}`.
2. Validate and render; hand the human the rendered page:

   ```sh
   node "$FW/scripts/kairos-records.mjs" validate .aiwg/kairos/packets/KP-20260926-gas-spike.json
   node "$FW/scripts/kairos-records.mjs" render-packet .aiwg/kairos/packets/KP-20260926-gas-spike.json > .aiwg/kairos/packets/KP-20260926-gas-spike.md
   ```

3. Ask one question: approve, reject or defer, with a reason code (for example `EVIDENCE_SUFFICIENT`, `INTERVENTION_CONTRADICTS`, `POLICY_NOT_READY`, `NEED_MORE_WINDOWS`). Start a clock when the packet is presented.
4. Record the answer as a new version of the packet (never edit a signed one): `decision {outcome, reason_code, reviewer, signed_at, review_minutes, note, calibration_label: true}`; set `human_go_signoff: true` only for approve. Re-validate: the validator rejects an approve without sign-off, a sign-off without approve, and a `signed_at` before `recorded_at`.
5. Append the calibration label:

   ```sh
   python3 - <<'PY'
   import json, hashlib
   p = ".aiwg/kairos/packets/KP-20260926-gas-spike.json"
   raw = open(p, "rb").read(); d = json.loads(raw)
   label = {"packet_id": d["packet_id"], "packet_sha256": hashlib.sha256(raw).hexdigest(),
            "reasons": d.get("escalation_reasons", []), "outcome": d["decision"]["outcome"],
            "reason_code": d["decision"]["reason_code"], "review_minutes": d["decision"].get("review_minutes"),
            "gates": {g["id"]: g["status"] for g in d["gates"]}}
   open(".aiwg/kairos/packets/calibration-labels.jsonl", "a").write(json.dumps(label) + "\n")
   PY
   ```

6. Route the result: approve goes to `kairos-operate` with the packet id and sha256; reject keeps the edge a candidate (or demotes an active one); defer lists what evidence is missing.

## Outputs

Packet JSON and Markdown, the decision, and one calibration label per decision. Labels show which escalation reasons humans always overturn or always confirm; propose policy changes from them in the pilot report, with the counts.

## Continue or hold

Silence is not a decision. An agent never sets `human_go_signoff`, never writes a decision on a human's behalf, and never treats a deferred packet as approved.
