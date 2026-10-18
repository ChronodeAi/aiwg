# Behavior activation preparation (#3222)

The accepted [activation ADR](adr-rule-activation-and-bound-delivery.md) assigns
all eight emulated behaviors to `bound`; none is kernel. The canonical bundles
retain their bodies, triggers, scripts, and native runtime metadata.
`collectBehaviorDirs` and `deployEmulatedBehaviors` in
`tools/agents/providers/base.mjs` remain unchanged. Activation-aware placement
and injected Bound rules blocks are deferred to #2939; show/MCP expansion is
#2940. This change does not claim runtime delivery or model-probe compliance.

## Binding inventory

Source paths below are relative to `agentic/code/`; each directory contains
`BEHAVIOR.md`. Targets resolve uniquely by type and exact show selector in an
artifact index built from canonical agent/skill definitions (excluding generated
plugin copies), as verified by
`test/unit/providers/behavior-activation.test.ts`.

| Canonical behavior directory | Agent selectors | Additional skill |
|---|---|---|
| `behaviors/concierge` | `concierge` | — |
| `behaviors/test-watcher` | `test-engineer` | — |
| `behaviors/build-monitor` | `build-engineer` | — |
| `behaviors/security-sentinel` | `security-auditor` | — |
| `frameworks/sdlc-complete/behaviors/artifact-sync` | `context-librarian` | `build-artifact-index` |
| `frameworks/sdlc-complete/behaviors/quality-gate-watcher` | `quality-assessor`, `security-gatekeeper` | — |
| `addons/aiwg-fleet/behaviors/quiet-bot` | `fleet-quiet-bot` | — |
| `addons/aiwg-fleet/behaviors/quiet-business-bot` | `fleet-business-bot` | — |

The concierge definition is under `addons/daemon/agents/`; the six existing
SDLC agents and indexing skill are under `frameworks/sdlc-complete/`. The two
new fleet adapter definitions are under `addons/aiwg-fleet/agents/`, registered
in that addon's manifest. They require the complete behavior contract before
handling model-assisted messages. Schedules and script-only handlers retain
their existing owners.

## Startup byte accounting

Offline replay on 2026-10-18 calls the existing `deployEmulatedBehaviors` with
`collectBehaviorDirs(process.cwd())`, provider `claude`, version `3222`, and
source `bundled`, into a fresh system temporary directory. Count raw UTF-8 file
sizes in `.claude/rules/behaviors/`. Working directory:
`/home/roctinam/dev/jmagly/aiwg-wt/3222`.

Both replays use identical wrapper options and source-relative paths. The
baseline was captured before adding frontmatter. The current transitional
replay includes the new metadata inside the generated source fences. The last
column is a projection after #2939 honors activation, not an observed reduction
from this metadata-only change.

| Behavior wrapper | Before metadata (bytes) | Current transition (bytes) | With #2939 (startup bytes) |
|---|---:|---:|---:|
| `artifact-sync.md` | 2,170 | 2,362 | 0 |
| `build-monitor.md` | 2,544 | 2,697 | 0 |
| `concierge.md` | 14,150 | 14,291 | 0 |
| `quality-gate-watcher.md` | 2,756 | 2,934 | 0 |
| `quiet-bot.md` | 2,583 | 2,759 | 0 |
| `quiet-business-bot.md` | 2,738 | 2,927 | 0 |
| `security-sentinel.md` | 3,184 | 3,364 | 0 |
| `test-watcher.md` | 2,778 | 2,935 | 0 |
| **Total** | **32,903** | **34,269** | **0** |

Projected savings versus the untagged baseline: **32,903 bytes (100%)**, about
8,226 tokens using the ADR's bytes / 4 estimate. Versus the tagged transition,
the reduction will be 34,269 bytes. Full contracts still cost context when a
bound agent or skill is invoked. Rule bodies, generated rule indexes, agent
listing descriptions, and other bootstrap context are outside this subtotal.
The ADR's 32,927-byte replay and PO's 33,411-byte baseline used different wrapper
paths/options; neither is a byte-exact fixture for this replay.

## Validation boundary

The new test validates every collected source against the ADR inventory,
activation field contract, summary limit, and binding resolution. It also
checks that the current Claude deployment retains all eight complete contracts.
The local contract adapter is isolated for replacement with the shared #2938
parser/validator. Live model probes, six-provider bound delivery, and dispatch
compliance remain later integration gates; no model calls are made here.

Local validation passed:

- `nice -n 19 npm run typecheck`
- `nice -n 19 npm run build:cli`
- `nice -n 19 ./node_modules/.bin/vitest run --config config/vitest.config.js --maxWorkers=4 test/unit/providers/behavior-activation.test.ts test/unit/providers/behavior-emulation.test.ts test/unit/extensions/behavior-deploy.test.ts test/unit/plugin/behavior-metadata-validation.test.ts` — 4 files, 50 tests.
- `nice -n 19 npm run package-plugins`, followed by `lint:plugin-copies`.
- CI lints: `lint:dep-sources`, `lint:eval-imports`,
  `lint:package-license-boundary`, `lint:agent-sizes`,
  `lint:test-registration`, `lint:test-process-timeouts`,
  `lint:orchestration-packs`, `lint:schemas`, `lint:ops-templates`,
  `lint:mission-inventory`, `lint:mission-contract`, `lint:plugin-copies`,
  `lint:vault-migration`, and `lint:session-fixtures` — all 14 passed.

The task prohibits Git operations, network, and access outside this worktree
and system temporary storage. Consequently `lint:generated-artifacts` (uses
`git ls-files`), `lint:audit-signatures` (registry audit), and the conditional
`lint:affected-packages` (external CSV feed) were not run. The mission inventory
lint used its normal `rg` enumeration; no Git fallback was needed.
