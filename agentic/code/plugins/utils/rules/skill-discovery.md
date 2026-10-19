---
enforcement: high
triggers:
  - "does AIWG have a skill for this"
  - "how do I find a capability"
  - "is there a command for this"
  - "AIWG does not seem to have"
activation: kernel
---

# Skill Discovery Rules

- MUST classify every user turn before acting: continuation stays in context; a new directive resets discovery. The first turn, first turn after `/clear`, a pivot, or fresh imperative after tool output is a new directive. Act on implied directives naming capabilities, including pasted `address-issues` tables. If genuinely ambiguous, ask one question. On misclassification, stop, acknowledge, discover the actual directive, and resume from the correct skill.
- On a new directive, MUST internally name the task → `aiwg discover "<parsed need>"` → `aiwg show <type> <name>` → act, even if the skill seems known. Query exemptions only: a specifically named skill/command, need clearly outside AIWG, same need already queried this session, or a quickref directly listing the skill.
- For AIWG/framework/capability lookups, `aiwg discover` MUST precede information gathering. Before consulting it this session, Grep/Glob/Read against provider directories, provider context files, or `agentic/code/` for AIWG lookup is FORBIDDEN. This includes Claude, Codex, Copilot, Cursor, Warp, Windsurf, Factory, OpenCode, Hermes, and OpenClaw locations. When delegation is available, prefer `aiwg-finder` for lookup.
- MUST query before declining an AIWG capability or improvising a workflow. Use the top match; present top three if close. Quickrefs are orientation, never an exhaustive catalog; do not enumerate or fabricate skills from memory. Read capabilities, not just names, before deciding a need is out of scope. A known deployed command missing from discover is an index bug, not proof of absence.
- Before invoking a discovered or loaded component, MUST fetch and follow every `required_rule_checks` entry and governing bound rule. Discovery summaries and pointers are not full rules; complete these checks before governed work, including subagent work.
- After discover returns a path, MUST fetch with `aiwg show <type> <name>`; find/ls/Glob/Grep/Read on that path is FORBIDDEN. After native Skill errors, use show, then show with `--json` for a path/content envelope. Only if the CLI is broken may you read the canonical `$AIWG_ROOT/agentic/code/{frameworks,addons}/<bundle>/skills/<name>/SKILL.md` corpus directly, then repair via aiwg-doctor → aiwg-refresh. Searching provider skill mirrors is never a valid fallback.
- MUST tell the user when querying and name the top candidate(s) with a one-line capability summary. If discovery was skipped or followed by filesystem navigation, stop and recover with discover → show → apply. Use parsed intent for AIWG research; a discovery match does not authorize destructive invocation. Decompose complex multi-skill flows rather than absorbing them.

- Subject to the listed query exemptions, for any request mentioning AIWG, a framework name (sdlc, research, forensics, ops, security-engineering, knowledge-base, marketing, media-curator), or a capability keyword (skill, agent, rule, command, addon, workflow, flow, template), aiwg discover MUST be the first information-gathering call.
- Before declining an AIWG capability, run aiwg discover with the appropriate --type and read the top result's capability rather than only its name.

Supporting rationale and examples: [skill-discovery-guidance](./skill-discovery-guidance.md) (`aiwg show rule skill-discovery-guidance`, on-demand).
