---
id: kairos-node-isolation
name: Kairos Node Isolation
description: Agents touch only the Kairos node the project configured; never discover, probe or write to any other node.
enforcement: critical
triggers:
  - "which kairos node should I use"
  - "kairos is on another port"
  - "use the local kairos"
  - "reset the kairos store"
---

# Kairos: Node Isolation

## Scope

Applies to every request an agent sends to Kairos: REST, MCP, agent tools, CLI clients and admin routes.

## Requirements

- The project declares its node once, in `.aiwg/kairos/connection/node.json` (`{"url": "<origin>", "expected_profile": "dev|pg", "purpose": "..."}`), written by a human or by `kairos-connect` at the human's instruction. Every command uses `KAIROS_URL` taken from that file.
- Never scan ports, guess a default (`4100`, `4101`), read another install's `kairos.env`, or fall back to a different node when the configured one is down. A down node is a finding or a blocker, not a reason to switch.
- Never start, stop, upgrade, reset, back up, restore or reseed a node from this framework. Operating the node is the operator's job; `POST /api/v1/admin/store/reset`, `/admin/circuit-breaker/*` and `/admin/seeds/reload` are out of scope.
- Keep writes inside the project's namespaces, recorded in the pilot plan. Never write into `kairos.access` or another project's namespace.
- Tokens come from the environment (`KAIROS_API_TOKEN`) and are never written to disk, logs, records, issues or commit messages.
- Browser-origin requests to `/mcp` are refused by design (`AGENT-SETUP.md:149-150`); do not add an `Origin` header or ask the operator to allowlist one.

## Required response

When the configured node is unreachable or reports an unexpected version or profile, stop node traffic, record the observation in `.aiwg/kairos/connection/`, and ask the operator. Do not look for another node.
