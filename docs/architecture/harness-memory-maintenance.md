# Harness memory maintenance: taxonomy and provider contracts (#3279)

Status: design note for epic #3278, wave 1. Citations such as `plan:7`,
`architecture.md:3`, `requirements` (UC/NFR ids), `risks-security.md`,
`test-strategy` and `research-vendor-docs.md` refer to the epic's planning
package (filed with #3278 on 2026-10-18; issue-planner `harness-maintenance`).
Issue references (#3279–#3285) are the work-package issues. This note is the contract
for #3280 and later slices. It composes existing owners; it creates no new
memory database (NFR-01).

CLI decision (2026-10-24, #3280): audit extends the existing `aiwg memory`
command as `aiwg memory audit`. Lifecycle command names remain proposals for
#3284; the proposed `aiwg harness memory` family is not introduced.

## 1. Existing-surface map

| Owner | Provides today | Gap #3278 fills |
|---|---|---|
| Context firewall | Read-only `scan`, plan-first `baseline --plan` / `--write --confirm-reviewed`, trust/review/digest/size findings without bodies, portable budget attribution; engine `tools/security/context-memory-firewall.mjs:10` (`aiwg.context-memory-firewall/v1`, `...-baseline/v1`); operator model `docs/security/context-memory-firewall.md` | Firewall covers provider-facing context, not placement/lifecycle ops. #3280 extends its inventory into a unified audit; it does not replace the firewall writer's fail-closed checks. |
| Semantic-memory + artifact index | `memory-ingest` (topology-contract ingest), `memory-lint`, `memory-log-append/render`, `memory-query-capture` in `agentic/code/addons/semantic-memory/skills/`; artifact graph via `aiwg index neighbors --graph kb`, build in `src/cli/handlers/subcommands.ts:1276`, move/reindex in `src/cli/handlers/artifacts.ts:17` | Ingest/lint/query exist; tombstone-aware retrieval exclusion and cross-store identity do not. Defined in sections 2 and 4. |
| Project registry | `src/memory/project-registry.ts`: manifest v1 (33), index v1 (38), lookup found/missing/ambiguous (46), root resolution project-local/user/default (51), home `~/.aiwg/projects` (56) | Registry resolves roots; it has no memory-item taxonomy. #3279 layers taxonomy over its resolution. |
| Compound-memory | Orchestration only, no storage (`agentic/code/addons/compound-memory/skills/compound-memory/SKILL.md:17`); ingest/retrieve/capture/manage/review/update/maintain workflows (SKILL.md:29-57); deterministic maintain preview, delegated receipts (`docs/overview.md:51`); pack budget 2000/4000/1500/500, total enforced (overview.md:57); canonical context at `.aiwg/context/compound-memory/context.json` with exact-preview confirm, supersede-on-replace, revoke-keeps-disposition (overview.md:70); ADR `docs/architecture/adr-compound-memory-lifecycle.md` (accepted, #2000) layer-ownership table | Exact-preview review and source-purge dependent dispositions (overview.md:25) are reused by #3282. Compound-memory never refreshes provider adapters (overview.md:83); provider regeneration stays with existing deploy workflows. |
| Sessions (candidate review) | Exact-candidate-version review and `sessions promote` gateway; commands in `agentic/code/addons/aiwg-utils/commands/sessions.md`, harvest in `.../skills/session-harvest/SKILL.md` | Reused as the review gate for session-derived knowledge. Note: there is no `agentic/code/addons/sessions/` directory; the plan's "sessions" means the aiwg-utils session skills and commands. |
| Line-memory | Bounded recency-ordered facts (`agentic/code/addons/line-memory/skills/line-memory/SKILL.md`); backing `.aiwg/memory/line-memory.txt` + sidecar meta (`src/memory/context-pack.ts:118`); `archive`/`supersede` with reviewer+reason+confirm, stable `lm_<uuid>` handles, sidecar tombstones, dry-run preview (`docs/overview.md:69-97`) | Already the reference lifecycle implementation. #3282 generalizes its preview/confirm/tombstone pattern; #3279 standardizes the record shape. |
| Context packs | `buildContextPack` (`src/memory/context-pack.ts:247`), `buildWorkspaceContextPack` (342); candidate locator+digest (136), lexical rank (236); transient digest-addressed product, never edited in place (compound ADR) | Pack builder exists; budget attribution (#3281) and retrieval-before-removal checks (#3282) build on it. |
| Rule-binding (#2935) | ADR `docs/architecture/adr-rule-activation-and-bound-delivery.md` (accepted): `isAlwaysOnRule` in `tools/agents/providers/base.mjs` gates delivery; `showArtifact` in `src/artifacts/query-engine.ts` returns text without rules; Cursor adapter forces `alwaysApply: true` except globs/applyTo | Epic #2935 is active work, not a delivered contract. #3278 depends on its activation/budget outputs (#2936/#2938 per #3281) but must not reimplement them. |
| Provider deployment | `src/providers/provider-definitions.ts` registry; `deployedSkillRoots` (`src/providers/deployed-skill-roots.ts:6`); `collectProviderInventory` (`src/providers/provider-inventory.ts:140`); capability matrix `agentic/code/providers/capability-matrix.yaml` (via `capability-matrix.ts:251`) | Registry holds deploy paths and context contracts. #3279 adds memory-surface adapters over it (section 3), not another path table. |

Plan-assumed items that do not hold as stated: the steward all-provider display
omitted Muse though the registry and matrix contain it; the registry's Copilot
precedence text conflicts with official no-general-precedence documentation
(both in `research-vendor-docs.md:34`, reconcile in #3280, do not silently
reword); no universal TTL, promotion score, or token threshold exists (plan:7);
`aiwg harness memory` commands are unimplemented proposals.

## 2. Taxonomy

Four axes, independent by plan:15 and #3279 acceptance. No transition may
change a second axis implicitly (#3282: no silent scope/authority change).

- Scope: `global` (user home, e.g. `~/.aiwg/projects`, `~/.openclaw/`) |
  `project` (workspace `.aiwg/`) | `provider-native` (files under a provider's
  deploy/discovery paths) | `loaded/session` (transient: startup context, task
  pack, tool descriptions, transitive includes). Default scope is current
  workspace; global requires explicit selection (NFR-02).
- Placement: `resident` (always-loaded: roles, rules, startup instructions) |
  `indexed` (retrievable: semantic-memory pages, KB, artifact index; the
  default per #3279) | `task-context` (bounded pack for one task) |
  `archived` (out of ordinary retrieval, restorable). Promotion moves toward
  resident; demotion moves away while retaining an indexed path (UC-03).
  Knowledge never gains instruction authority on promotion (architecture.md:11).
- Lifecycle: `active` | `superseded` (replaced, link retained) |
  `retired` (tombstone + history retained, excluded from ordinary retrieval) |
  `quarantined` (firewall/owner hold; architecture.md:7 adds it to the plan's
  active/superseded/retired set) | `purged` (source removed by the owning
  importer's purge only). Retirement is never a purge side effect (#3282).
- Authority: owner (which addon/store may mutate) + trust/source
  (who asserted it: operator, reviewer, import, generated-output-proposed) +
  protection (`pinned` mandatory constraints and rare obligations are never
  pruned by age; risks-security.md:5). Promotion cannot raise authority
  (risks-security.md:5); generated output stays proposed until reviewed
  (compound SKILL.md:59).

Observation status (per item, from research-vendor-docs.md:40): `observed`
| `inferred` | `on-disk` | `absent` | `inaccessible` | `opaque` | `unknown`,
with evidence source, timestamp, session/provider/version. Static inventory is
never labeled observed live context.

## 3. Provider maintenance contracts

Adapter interface (new in #3279, registry-driven over all of `PROVIDER_IDS`,
`provider-definitions.ts:291`, including `generic`):

```ts
interface ProviderMemoryAdapter {
  providerId: Platform;                       // one of PROVIDER_IDS; never hard-coded
  memoryRoots(): string[];                    // deploy + discovery + home paths
  disposition(item): 'observed'|'inferred'|'on-disk'|'absent'|'inaccessible'|'opaque';
  supports: { read, write, estimate, liveLoadVisibility: boolean };
  sessionEffect(op): 'current' | 'next-session' | 'unknown';
  // May touch: canonical AIWG sources + derived files via regeneration only.
  // May not touch: running immutable sessions, hidden provider system prompts,
  //   another scope without explicit selection, authority without review.
}
```

Per-provider contract (resident vs imported vs retrievable; static vs runtime;
evidence from research-vendor-docs.md:15-22 and `provider-definitions.ts`):

| Provider | Memory lives in | Static vs runtime | Maintenance limits |
|---|---|---|---|
| claude | `CLAUDE.md`, `.claude/`, native include `@WORKSPACE.md/@AIWG.md` (338); nested, 200-line rec | Static maps well. Imports still consume context at startup (vendor:17): splitting files is not demotion. Verify with `/context`. |
| codex | `AGENTS.override.md`/`AGENTS.md` root-to-cwd chain, 32 KiB ceiling (344) | Static discovery plus observed injection kept separate (vendor:15); truncation/restart boundaries are runtime-only. |
| copilot | user+repo+org instructions combine; no general precedence (350); `@` imports have scope limits (vendor:18) | Do not impose fabricated precedence. Surface + enabled/disabled state required; IDE/cloud/CLI not conflated. |
| hermes | `.hermes.md`, `AGENTS.md`, MEMORY.md/USER.md distinct stores, degraded (408) | Fresh writes can be invisible until a session boundary (vendor:21). Write success is not reload proof; report next-session effect. |
| openclaw | home config, degraded, no verified project startup file (434) | Bootstrap copy can truncate while the file stays intact; durable size vs injected size reported separately (vendor:22). `/context` gives raw vs injected sizes. |
| omp | `.omp/AGENTS.md` native nearest-nonempty, `@` include, depth-ordered dedup (446) | Strongest native contract; import smoke-verified. Canonical edits regenerate derived files. |
| opencode | `AGENTS.md`/`CLAUDE.md` + `opencode.json#instructions`, config-registration (428) | Registration key is the mutation point, not just the markdown. |
| cursor | `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.mdc`, no nesting (356) | `alwaysApply: true` forcing per rule-binding ADR; globs/applyTo are the only live exceptions. |
| antigravity, codex-chain (pi 457), warp (468) | project rules files, prose-directive, nested except cursor | Static inventory + precedence chains as declared; runtime load unobserved. |
| factory (373), grokbot (379), grok-build (392), muse (417), openhuman (440), deepseek-harness, windsurf/devin (474) | As declared in definitions; several degraded (`degraded` support flag) | Degraded/opaque items keep `unknown` estimates; never reported as measured (NFR-04). |
| generic | no startup files, `unsupported` (480) | Indexed baseline + explicit diagnostic only; no invented native adapter (vendor:30). |

Unknowns marked explicitly: hidden provider system content (`opaque`, never
claimed); live injection sizes except where `/context`-style diagnostics exist;
whether a file edit affects an already-running session (always `next-session`
or `unknown`, NFR-04); external memory providers linked from Hermes-class
hosts (enumerate connection, not content).

## 4. Record identity and lineage

- Identity: stable id derived from source locator + content digest
  (`stableEntryId`, `canonical-context.ts:150`; intake digest, `intake.ts:37`;
  sha256 `context-pack.ts:73`). Carry `sourcePath`, `digest`, `version`
  (revision counter, cf. canonical receipt `revision`), and `aliases`
  (prior ids, compatibility names such as `.windsurf` vs `.devin`).
- Supersession/merge/split: originals immutable; new record links
  `supersedes`/`mergedFrom`/`splitFrom`; line-memory supersession requires a
  replacement handle (overview.md:82); canonical replace retains the prior
  entry as superseded (compound overview.md:74). Cross-workspace import records
  source workspace identity and needs explicit authorization (overview.md:80).
- Tombstones: `{ id, digest, disposition, reason, reviewer, at, successor? }`
  in the owning store's sidecar (line-memory pattern, overview.md:82-90).
  Ordinary retrieval excludes non-`active` lifecycle states (compound context
  excludes invalid states, overview.md:62); restore/history lookup addresses
  tombstones explicitly. Purge is an owning-importer operation with dependent
  dispositions, never part of retire.

## 5. Plan and receipt shape

Reuse, do not redefine: `MemoryIntakePreview/Receipt` (`intake.ts:14,25`,
`wouldPromoteKnowledge: false`); `CanonicalContextPreview/Receipt/Export`
(`canonical-context.ts:56,70,83`, exact `operationId` confirm, diff/conflicts,
revision); firewall baseline plan + `loadBaseline` containment
(`context-memory-firewall.mjs:243`); line-memory `--dry-run --json` preview
and idempotent receipts. Define only the missing coordinator envelope:

```ts
type MaintenanceOp = 'promote'|'demote'|'recategorize'|'merge'|'split'
  | 'supersede'|'retire'|'restore';   // no 'purge' op (#3282 out of scope)
interface MaintenancePlan { schemaVersion: 'aiwg.maintenance-plan.v1';
  operations: [{ op, target: { id, digest, version }, from: { placement, lifecycle },
  to: { placement, lifecycle }, scope, rationale, uncertainty,
  impactedLinks: string[], sessionEffect: 'current'|'next-session',
  precondition: { digest, version } }]; }  // stale/concurrent rejected
interface MaintenanceReceipt { schemaVersion: 'aiwg.maintenance-receipt.v1';
  planDigest: string; ownerReceipts: unknown[]; // journaled per-owner receipts
  partial?: { completed: string[]; pending: string[] }; resumedFrom?: string; }
```

Invariants (hard): no implicit scope or authority change; retirement keeps the
tombstone and never purges source files; pinned/rare-obligation items are
rejected from age-based retirement (fixtures required, risks:5); indexed
retrieval verified before resident removal (#3282); canonical sources edited
so regeneration cannot resurrect retired text (risks:12); minimize bodies and
secret-bearing data in reports (risks-security).

## 6. Slice boundaries and acceptance

- #3279 (this note implements it): versioned types/schema for section 2/4/5
  YAML/JSON schemas, `ProviderMemoryAdapter` interface + registry enumeration
  (fail on missing provider, including generic), fixtures (rare-obligation pin,
  import-chain, truncation, cycle, alias collision, external-root). Tests per
  test-strategy "unit contracts": axis independence, stable identity/aliases,
  migration, protected entries, unknown telemetry, transitive-include cycles,
  per-provider estimate confidence.
- #3280: read-only `audit` (workspace default, explicit global/provider,
  human + versioned JSON, zero mutations); owner/scope/loading chains,
  dedup by identity keeping exposure paths, observed/inferred/on-disk/absent/
  inaccessible/opaque with evidence; reuse firewall, registry, resolvers.
- #3281 + #3282 (parallel after #3280): #3281 budget/utility attribution
  (estimator+confidence, startup vs per-task vs overhead, retrieval/exposure/
  use/rejection/unknown, integrate #2936/#2938); #3282 typed reversible ops
  through owners with exact-version review, journals, idempotent resume,
  current vs next-session reporting.
- #3283: evidence-ranked candidates with uncertainty, savings, retrieval
  impact, protected-item exceptions; advisory separated from approved mutation.
- #3284: common CLI/skill surfaces, discovery anchor only (no startup bloat),
  global/local targeting shown before mutation.
- #3285: registry-generated conformance roster; deterministic fixtures +
  separately-reported live native qualification; unchanged/no-memory/indexed/
  selected/resident baselines with recall, stale hits, activation, adherence,
  completion, cost, latency; migration retrieval; no smaller-file-alone gates.
