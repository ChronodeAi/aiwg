---
name: kairos-review-packet
description: Human-readable review packet for an escalated Kairos edge; the JSON packet is authoritative
---

# Review packet KP-<YYYYMMDD>-<edge slug>

Authoritative record: `.aiwg/kairos/packets/<packet_id>.json` (`kairos_review_packet/v1`). Render this page
with `node <framework>/scripts/kairos-records.mjs render-packet <packet.json>` rather than by hand.

Gate / status (PASS, FAIL, ESCALATED) / recommendation (GO, NO-GO, DEFER) / human sign-off / recorded at /
node and Kairos version / contract path and sha256:

## Subject
Source → target, vector type, sign, context parameters, current → proposed status, Kairos vector id if any.
Escalated because (one or more): live money or policy / gate disagreement / sign flip on an active edge / new
node type / signing or capital policy.

## Gates
| Gate | Status | Value | Threshold | Detail |
|---|---|---|---|---|
| EA-G1 baseline margin | | | | |
| EA-G2 proposer agreement (2 of 3 families) | | | | |
| EA-G3 statistic with FDR control | | | | |
| EA-G4 block and regime stability | | | | |
| EA-G5 point-in-time walk-forward | | | | |
| EA-G6 interventional confirmation | | | | |
| EA-G7 K-consecutive hysteresis | | | | |

All gates are computed client-side; Kairos 2.1.1 enforces none of them (ADR-0034 U34-C Proposed).

## Proposers and evidence
Proposer, family, kind, sign, proposal sha256. Data snapshot as-of and sha256. Sources with sha256.

## Change and impact
Exact node write (`diff.before` → `diff.after`). Decisions affected. Paper only, or live.

## Decision
Outcome approve, reject or defer / reason code / reviewer / signed at (UTC) / review minutes / note.
The decision is a calibration label. Silence is not a decision.
