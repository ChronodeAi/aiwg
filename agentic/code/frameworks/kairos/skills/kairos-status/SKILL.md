---
name: kairos-status
namespace: aiwg
platforms: [all]
description: "Summarize a Kairos pilot's state: node, gates CG to OP, pending review packets, gate decisions, findings and review minutes per admitted edge."
triggers:
  - kairos pilot status
  - kairos gate status
  - what is pending in the kairos pilot
  - kairos review minutes
commandHint:
  modelRole: efficiency
  modelTier: economy
---

# Kairos Status

## Workflow

1. Summarize the workspace (reads files only; no node traffic):

   ```sh
   AIWG_ROOT="${AIWG_ROOT:-$(aiwg version --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["packageRoot"])')}"
   FW="$AIWG_ROOT/agentic/code/frameworks/kairos"
   node "$FW/scripts/kairos-records.mjs" status .aiwg/kairos
   ```

   It reports the connection record's `gate_cg`, gate MB (every proposal validates), the latest gate decision per edge, packets pending a human, outcomes, admitted edges with review minutes per admitted edge, decision receipts (and how many were live), and findings by triage status with the ones not yet fileable.
2. Check the node is still the one recorded, without writing: `. "$FW/scripts/kairos-env.sh" && kget /api/v1/health; kget /api/v1/health/ready`. A different version from the connection record means re-running `kairos-connect` and the conformance baseline before more work.
3. Judge gates EA and OP from the files the summary points to:
   - EA: every `promote-*-vector.json` response under `decisions/` has `kfw_evidence_sha256` equal to an `auto_promote` evaluation's `evidence_sha256`, or a matching approved EA packet.
   - OP: `decisions.live` equals the number of OP packets with `human_go_signoff: true`.
4. Report in five lines: node and version; gate states with unmet criteria; pending human decisions (packet ids and the one question each asks); findings awaiting filing or evidence; the next action. Mark anything not read from a file as `[INFERENCE]`.

## Continue or hold

Status never changes state. Hand pending packets to `kairos-review-packet`, fileable findings to `kairos-feedback`, and a stale connection to `kairos-connect`.
