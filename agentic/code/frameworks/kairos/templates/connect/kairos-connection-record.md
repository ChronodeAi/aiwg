---
name: kairos-connection-record
description: Record what the configured Kairos node reports about itself, with no secrets
---

# Kairos Connection Record

Machine-readable form: `.aiwg/kairos/connection/connection-record.json`, schema
`kairos_connection_record/v1` (`schemas/connection-record.schema.json`). Validate with
`node <framework>/scripts/kairos-records.mjs validate`. This page is the human summary.

Node origin / declared in (`.aiwg/kairos/connection/node.json`) / expected profile (dev or pg) / purpose:
Recorded at (UTC) / recorded by:

| Check | Request | HTTP | Result | Evidence (sha256 or path) |
|---|---|---|---|---|
| Liveness | `GET /api/v1/health` | | status, version | |
| Readiness | `GET /api/v1/health/ready` | | ready true/false | |
| Capability contract | `GET /api/v1/meta` | | saved as `connection/meta.json` | |
| MCP initialize | `POST /mcp initialize` (2025-11-25) | | protocolVersion, serverInfo.version | |
| MCP tools | `POST /mcp tools/list` | | tool names | |
| Agent auth path | authenticated read, e.g. `GET /api/v1/auth/me` | | verified yes/no, admin yes/no | |

From `/meta`: version / `auth.enabled` / `auth.provider` / `auth.admin_waiver` / `authorization.profile` /
`authorization.namespace_policy` / `store.backend` / `mcp.requires_bearer` / `mcp.browser_access` /
`capabilities.neural_fallback` / `capabilities.federation_peers`.

Agent auth path: `none` (auth off) or `bearer_env` with the variable name (`KAIROS_API_TOKEN`), how an
operator obtains the token, and its lifetime. Never the token itself.

Conformance baseline receipt path and sha256 / pass-fail-skip-error counts / known gaps observed:

Gate CG: PASS or FAIL, with each unmet criterion. Mismatches between `/meta`, health and the expected
profile are findings, not reasons to use another node.
