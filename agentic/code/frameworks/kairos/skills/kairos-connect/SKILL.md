---
name: kairos-connect
namespace: aiwg
platforms: [all]
description: Declare the project's Kairos node and record its /meta, readiness, version, auth mode and agent auth path without secrets (gate CG).
triggers:
  - connect to a kairos node
  - kairos connection record
  - record kairos meta
  - kairos auth mode
commandHint:
  modelRole: coding
  modelTier: standard
---

# Kairos Connect

## Inputs

The node origin from the operator (for example the dedicated dogfood node `http://127.0.0.1:4110`, pg profile), the expected profile (`dev` or `pg`), and how the operator issues a token. Never pick a node yourself (`kairos-node-isolation`).

## Workflow

1. Declare the node once. Only a human supplies the URL:

   ```sh
   mkdir -p .aiwg/kairos/{connection,proposals,evidence,packets,decisions,observations,conformance,findings,reports}
   cat > .aiwg/kairos/connection/node.json <<'JSON'
   {"url": "http://127.0.0.1:4110", "expected_profile": "pg", "purpose": "dogfood pilot",
    "token_source": "Privy access token from an operator browser login", "token_lifetime_note": "about one hour"}
   JSON
   ```

2. Locate the framework and load the helpers. `kairos-env.sh` sets `KAIROS_URL` from `node.json`, refuses a different `KAIROS_URL`, and passes `KAIROS_API_TOKEN` to curl through a file descriptor:

   ```sh
   AIWG_ROOT="${AIWG_ROOT:-$(aiwg version --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["packageRoot"])')}"
   FW="$AIWG_ROOT/agentic/code/frameworks/kairos"
   . "$FW/scripts/kairos-env.sh"
   ```

3. Look before recording. These are the public, unauthenticated reads (API.md "Health & Status" and "Meta"):

   ```sh
   kget /api/v1/health; echo            # {"status":"ok","version":"2.1.1",...}
   kget /api/v1/health/ready; echo      # 200 when bootstrapped and the breaker is not HALTED
   kget /api/v1/meta | python3 -m json.tool   # auth, authorization, store, mcp, agent_tools, capabilities
   ```

   `/meta` decides the auth path: `auth.enabled: false` means no token (dev profile; `auth.admin_waiver` shows the development admin waiver). `auth.enabled: true` means every call except health and meta needs `Authorization: Bearer $KAIROS_API_TOKEN` (a Privy token; the pg profile always enforces it).

4. With auth on, get a token from the operator and export it in this shell only: `read -rs KAIROS_API_TOKEN && export KAIROS_API_TOKEN`. Never paste it into a file, record, issue or commit message.

5. Record everything in one pass:

   ```sh
   node "$FW/scripts/kairos-connect.mjs"      # exit 0: gate CG PASS, 3: FAIL (unmet criteria printed)
   ```

   It calls `GET /api/v1/health`, `/health/ready`, `/meta`, MCP `initialize` (protocol `2025-11-25`), `notifications/initialized` and `tools/list`, then verifies the agent auth path with `GET /api/v1/auth/me` (auth on) or MCP reachability (auth off). It saves raw public bodies under `.aiwg/kairos/connection/raw/<stamp>/`, copies `/meta` to `connection/meta.json`, keeps only the sha256 and role of `/auth/me` (the body holds email and wallet fields), and writes `connection/connection-record.json` (schema `kairos_connection_record/v1`). The same checks by hand:

   ```sh
   kmcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"kairos-connect","version":"1"}}}'
   kmcp '{"jsonrpc":"2.0","method":"notifications/initialized"}'          # HTTP 202, no body
   kmcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | python3 -c 'import json,sys; print([t["name"] for t in json.load(sys.stdin)["result"]["tools"]])'
   kcurl "$KAIROS_URL/api/v1/auth/me" -o /dev/null -w '%{http_code}\n'      # 200 with a valid token
   ```

6. Run the conformance baseline (read-only by default; details in `aiwg show skill kairos-conformance-probe`), then attach its receipt so gate CG can pass:

   ```sh
   python3 "$FW/skills/kairos-conformance-probe/scripts/kairos_conformance.py" --node "$KAIROS_URL"
   node "$FW/scripts/kairos-connect.mjs" --baseline-receipt .aiwg/kairos/conformance/<run_id>/receipt.json
   node "$FW/scripts/kairos-records.mjs" validate .aiwg/kairos/connection/connection-record.json
   ```

7. Fill the human summary with `aiwg show template kairos-connection-record` if the pilot plan asks for one.

## Outputs

`node.json`, `meta.json`, `connection-record.json` with `gate_cg`, and raw bodies. `secrets_recorded` is always `false`; the validator fails on a JWT, bearer value, private key or GitHub token in the record.

## Continue or hold

Continue to `kairos-propose-graph` when gate CG passes. Hold when the node is down, not ready, reports a different version on `/health` and `/meta`, or a profile other than the declared one; record the observation and ask the operator. A mismatch between the docs and what the node reports is a finding for `kairos-feedback`, not a reason to switch nodes.
