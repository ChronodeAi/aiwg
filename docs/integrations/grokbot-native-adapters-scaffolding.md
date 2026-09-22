---
audience: agent-operator
publication: integration
stable_id: aiwg.integration.grokbot-native-adapters-scaffolding
---

# Grok Bot optional native adapters — fail-closed scaffolding

**Status:** Evidence-gated scaffolding (writers blocked)

**Modules:** `src/providers/grokbot-natives/`

**Evidence catalog:** [grokbot-native-surfaces-evidence.md](./grokbot-native-surfaces-evidence.md)

**Tracking:** children of [#209](https://github.com/jmagly/aiwg/issues/209):

- [#241](https://github.com/jmagly/aiwg/issues/241)
- [#242](https://github.com/jmagly/aiwg/issues/242)
- [#243](https://github.com/jmagly/aiwg/issues/243)
- [#244](https://github.com/jmagly/aiwg/issues/244)
- [#245](https://github.com/jmagly/aiwg/issues/245)

## Purpose

Isolate typed contracts, env kill-switches, and fail-closed entry functions for
optional Grok Bot native surfaces **before** any product import/API exists.
Baseline `aiwg use --provider grokbot` is unchanged. The capability matrix must
**not** claim AIWG installs routines, CreateAgent profiles, connectors, memory,
or machines.

## Hard gates

1. No invented writers (routines, profiles, connectors, machines, memory stores).
2. No secret scrape (clipboard, cookies, tokens, full bodies).
3. `#244` is read-only only — never register machines, never flip local-execution,
   never write credentials.
4. Opt-in / disableable; **default OFF**.
5. Fail-closed when product evidence (`importContractAvailable`) is missing.

## Kill-switches (default OFF)

| Surface | Issue | Env flag | Entry |
| --- | --- | --- | --- |
| Registered-machine health probe | #244 | `AIWG_GROKBOT_NATIVE_MACHINE_PROBE` | `registeredMachineHealthProbe()` |
| Memory reference helper | #245 | `AIWG_GROKBOT_NATIVE_MEMORY_REF` | `memoryReferenceHelper()` |
| Routines / cron generator stub | #241 | `AIWG_GROKBOT_NATIVE_ROUTINES` | `generateRoutinesImportStub()` |
| CreateAgent / teammate projection | #242 | `AIWG_GROKBOT_NATIVE_CREATE_AGENT` | `projectCreateAgentStub()` |
| Connector / MCP install profile | #243 | `AIWG_GROKBOT_NATIVE_CONNECTORS` | `buildConnectorInstallProfileStub()` |

Truthy enable values: `1`, `true`, `yes`, `on`. Unset / empty / `0` / `false` /
`no` / `off` → disabled.

Enabling a flag does **not** unlock writers. Entry functions still return
`blocked` until Decision-gate criteria in the evidence catalog are met.

## Result statuses

| Status | Meaning |
| --- | --- |
| `disabled` | Kill-switch off (default) |
| `blocked` | Enabled but product import/API/reload evidence missing |
| `unavailable` | Reserved for reachable-but-unimplemented future paths |
| `proposed` | In-memory dry-run / paste proposals only (`#245`) — never writes |

Every result sets `wrote: false`.

## Module layout

```text
src/providers/grokbot-natives/
  index.ts                      # re-exports + skippable optional status helper
  types.ts                      # shared contracts / statuses
  flags.ts                      # env kill-switch constants
  evidence.ts                   # product evidence snapshots (gated false)
  registered-machine-health.ts  # #244
  memory-reference-helper.ts    # #245
  routines.ts                   # #241
  create-agent.ts               # #242
  connector-install-profile.ts  # #243
```

## Optional doctor / status hook

`collectGrokbotNativeOptionalStatus()` is **skippable** and default-empty. When
`AIWG_GROKBOT_NATIVE_MACHINE_PROBE=1`, it runs the read-only `#244` probe only.
It never fails baseline deploy and does not auto-invoke writer stubs. Doctor /
status may import it later; scaffolding does not wire it into the deploy path.

## Decision-gate unblock (per surface)

A surface may move beyond scaffolding only when **all** are true (see evidence
catalog):

1. Public product docs (or maintainer-attested evidence) publish an
   import/API/reload contract suitable for automation.
2. Contract is cited in the implementation PR with reproduction steps.
3. Adapter remains isolated, confirmation-gated, and disableable.
4. Capability matrix stays honest (native *capability* ≠ AIWG installer).

## Related

- ADR: [adr-grokbot-provider-target.md](../architecture/adr-grokbot-provider-target.md)
- Provider guide: [docs/agents/providers/grokbot.md](https://github.com/jmagly/aiwg/blob/v2026.9.19/docs/agents/providers/grokbot.md)
- Quickstart: [grokbot-quickstart.md](./grokbot-quickstart.md)
