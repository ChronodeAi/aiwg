# Kairos surfaces this framework uses

Citations are to the Kairos repository at tag `v2.1.1` (commit `6e0ccc01`). Re-check them when the node version changes; `kairos-connect` records the version from `/api/v1/meta`.

| Need | Surface | Auth | Citation |
|---|---|---|---|
| Liveness, readiness | `GET /api/v1/health`, `GET /api/v1/health/ready` (503 when not bootstrapped or the breaker is HALTED) | none | API.md:266-293 |
| Capability contract | `GET /api/v1/meta`: `version`, `auth{enabled, provider, admin_waiver}`, `authorization{profile, namespace_policy}`, `store.backend`, `mcp{protocol_version, requires_bearer, browser_access, tools}`, `agent_tools`, `capabilities` | none | API.md:317-379 |
| Bearer auth | `Authorization: Bearer <Privy token>` on everything except health, meta, docs and metrics; CLI clients read `KAIROS_API_TOKEN` | — | API.md:76-83; `src/cli/query.py:112` |
| Who am I | `GET /api/v1/auth/me` (401 without a principal; body has email and wallet fields, so only its hash and role are kept) | bearer | API.md:1208-1227; `src/server/routes/auth.py:21-46` |
| Retry-safe creates | `POST /api/v1/agent/tools/execute` with `create_xtype`, `create_vector` (`idempotency_key` required, 24 h replay) | bearer + namespace write | API.md:1236-1348 |
| Resolve | `POST /api/v1/resolve`, MCP `kairos_resolve`; context limited to `user`, `roles`, `locale`, `timestamp` | bearer + namespace read | API.md:615-648, 1996; PRODUCT.md:86 |
| Causal what-if | `POST /api/v1/causal/intervene`, `/counterfactual`, `/validate-dag` (never change the store) | bearer + read | API.md:1022-1110 |
| Learn | `POST /api/v1/observations`, MCP `kairos_observe`, agent tool `observe` (admin; `ema-phi-v1`) | admin | API.md:700-803, 1995 |
| Receipt history | `GET /api/v1/observations` (admin, key-store rows, 24 h) | admin | API.md:883-931 |
| Access projection | `GET /api/v1/access` (admin, read-only) | admin | API.md:1903-1960 |
| MCP transport | `POST /mcp`, JSON only, protocol `2025-11-25`, 9 tools, `Origin` refused unless allowlisted, 30 writes per minute | bearer when auth on | AGENT-SETUP.md:142-152; PRODUCT.md:78 |

Profiles: dev is `--store sqlite`, auth off, admin waiver `KAIROS_REQUIRE_ADMIN_BYPASS=true`; pg is `--store postgres` with Privy auth always on (PRODUCT.md:74-77). Production uses the strict profile with an admin-only namespace policy.

## Gaps the framework expects

| Id | Observation | Where | Framework response |
|---|---|---|---|
| C1 | resolve returns `"trace": []` though the field is described as "Resolution trace log" | API.md:640; `src/server/models/resolution.py:227` | receipts note the empty trace; probe finding |
| C2 | resolve responses carry no store revision | API.md:627-641 | `store_revision: {"absent": "not_in_resolve_response"}` |
| C4 | adaptive admission is a hard 0.618 line on a point estimate | `src/neural/resolver.py:29-34` | reported when one observation opens or closes a route |
| C6 | LLM-derived causal weights are written straight to the store | `src/causal/live_providers.py:276-300` | never called; any use is a finding |
| — | ADR-0034 gate stack not enforced; no candidate/active status | ADR-0034:3,127-128 | gates run client-side (`scripts/kairos-gates.mjs`) |
| — | observation receipts have no `propensity` or `randomness_key` request fields | API.md:796-797 | EA-G6 records randomization client-side |

## Documentation drift noticed while authoring (candidates for findings)

These are doc-to-doc observations, not node observations; confirm them on the node before filing.

- `AGENT-SETUP.md:3,14` and `scripts/install-kairos.sh:28-29` at tag `v2.1.1` still install and pin `v2.0.0`, which has no `/api/v1/meta`; an agent following the 2.1.1 setup page gets a node without the capability contract.
- `PRODUCT.md:80` says "Auth mode is not discoverable today ... No `/meta` route exists", while `API.md:317-379` documents `GET /api/v1/meta` and `src/server/routes/meta.py:231` serves it.
- `API.md:1160` still says `POST /behavioral/directives` needs `X-Admin-Key` in addition to `X-API-Key`; PRODUCT.md:137 calls `X-API-Key` stale.
