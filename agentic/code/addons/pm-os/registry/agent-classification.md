# Agent-Like Surface Classification

Phase 7 classifies agent-like files so PM OS does not create decorative subagents.

## Active Subagents

| Surface | Classification | Rationale |
|---|---|---|
| `agents/pm-workflows.md` | active subagent | Owns workflow routing and step orchestration when isolated context is useful. |
| `agents/knowledge-librarian.md` | active subagent | Read-only framework/skill retrieval with bounded output. |
| `agents/context-manager.md` | active subagent | Read-only `/status` state snapshot with bounded output. |
| `agents/*-reviewer.md` | active subagents | Independent review lenses for `/review`; read-only, evidence-focused, parallelizable. |

## Router Prompts, Not Subagents

| Surface | Classification | Rationale |
|---|---|---|
| `AGENTS.md` | global router | Always-on operating rules and routing policy. |
| `.cursor/rules/*.mdc` | compaction-survival rules | Persistent invariants, not task workers. |
| `.cursor/commands/**/*.md` | generated stubs | Route to canonical command files. |
| `skills/*/SKILL.md` | command prompts | User-facing command contracts. |
| `skills/*/SKILL.md` | workflow prompts | Sequenced workflow definitions; only `/review` delegates to subagents today. |

## Skill-Like Or Deferred

| Surface | Classification | Rationale |
|---|---|---|
| `skills/skill-browser/SKILL.md` | skill-like, review later | Overlaps with `knowledge-librarian`; keep as skill until skill discovery architecture is revisited. |
| `skills/pm-os-tidy/SKILL.md` | supporting procedure skill | `/tidy` plugin command is canonical; skill remains supporting detail. |

## Rule

No workflow may claim subagent support unless:

1. Agent exists under `agents/`.
2. Cursor and Claude mirrors exist.
3. `registry/agents.json` declares it.
4. `registry/workflows.json` references it.
5. `bin/validate-agent-registry.sh` and `bin/validate-workflow-registry.sh` pass.
