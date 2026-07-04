---
enforcement: high
---

# Skill Discovery Rules

**Enforcement Level**: HIGH
**Scope**: All AIWG-deployed agents on platforms with skill-listing budgets
**Addon**: aiwg-utils (core, universal)
**Issue**: #1215 (parent epic #1212)

## Overview

AIWG ships hundreds of skills, agents, rules, and provider compatibility surfaces across its installed frameworks. Agentic platforms (Claude Code, OpenClaw, Codex, Cursor, Factory, etc.) cap how many skills they will list in any given context — Claude Code at 25% of context window by default, OpenClaw at 150 hard, others on similar trajectories. To work within those caps, AIWG deploys two tiers:

- **Kernel skills** at the platform-native skills directory (`.claude/skills/`, `.factory/skills/`, etc.) — always loaded. ~10 today: one quickref per installed framework + a small core utility set.
- **Standard skills** at `<provider-dir>/.aiwg/skills/` — *not* listed by the platform. Reachable only through the AIWG artifact index.

This means **most AIWG skills are not in your context**. You see the kernel set; the rest exists but is invisible until you query for it.

## Problem Statement

Without explicit framing, an agent operating in this layout will:
- Look at its loaded skill set, see ~10 quickrefs, and conclude AIWG can't do something
- Decline a user request that *would* be served by a skill the agent doesn't see
- Re-derive a workflow from scratch when a curated skill already exists for it
- Enumerate from memory and miss the bulk of the available surface

The fix is a single discipline: **query the index before declining or improvising**.

## Mandatory Rules

### Rule 0: Recognize Directive Boundaries Before Acting

Classify every user turn before acting:
- **Continuation** — extends work in flight ("and also fix the test", "use Postgres instead"). Stay in context.
- **New directive** — a fresh task, often with its own scope ("address-issues #1230", "now do a security review"). Reset to discovery mode.

Re-classify at every turn boundary — **not just session start**: (1) the first message is always a new directive; (2) **after `/clear`**, the next message is a new directive even if it sounds like a continuation; (3) a user can pivot mid-session; (4) a fresh imperative after tool output is a new directive.

**On a new directive you MUST**: (1) name the task internally; (2) search the index via `aiwg discover` — non-optional, even if you think you know the skill, because the index is authoritative; (3) fetch with `aiwg show <type> <name>`; (4) then act. Skipping 1–3 is the failure this rule prevents. Common failure: user pastes a directive that names a skill (e.g. an `address-issues` table) and the agent reads it as commentary instead of acting.

If genuinely ambiguous (continuation vs new directive), ask one question rather than guessing. If you notice mid-session you misclassified, stop, acknowledge it, run `aiwg discover` against the actual directive, and resume from the correct skill.

### Rule 1: Query the Index Before Declining

Before saying "AIWG doesn't have a skill for that," you MUST run `aiwg discover "<the user's need, paraphrased>"`. The index covers every deployed artifact, including the 90%+ not in your context. Use the top match; if several are close, present the top-3.

**FORBIDDEN**: "AIWG doesn't seem to have a deployment skill, let me write a custom script." **REQUIRED**: run `aiwg discover "deploy production"` → use `flow-deploy-to-production`.

The index covers every deployed AIWG skill, agent, rule, and legacy command bridge — including the 90%+ that aren't loaded in your context. If `discover` returns ranked candidates, load and use the top match. If multiple are close, present the top-3 to the user.

### Rule 1.5: Discover BEFORE Filesystem Search (discover-first protocol)

For any request mentioning **AIWG**, a framework name (sdlc, research, forensics, ops, security-engineering, knowledge-base, marketing, media-curator), or a capability keyword (skill, agent, rule, command, addon, workflow, flow, template), `aiwg discover` MUST be the first information-gathering call.

`Grep`/`Glob`/`Read` against these dirs is **FORBIDDEN** for AIWG lookups until `aiwg discover` has been consulted at least once this session: `.claude/`, `.codex/` / `~/.codex/`, `.github/{agents,skills,instructions,prompts}/`, `.cursor/`, `.warp/` / `WARP.md`, `.windsurf/` / `AGENTS.md`, `.factory/`, `.opencode/`, `.hermes.md` / `~/.hermes/skills/`, `~/.openclaw/`, and `agentic/code/` (when inside the AIWG repo). The failure this prevents: a literal-string grep hit short-circuits discovery and misses 10× the surface a ranked `aiwg discover` would return.

**When subagent delegation is available** (Claude Code Task tool, Hermes `delegate_task`, etc.), prefer dispatching the `aiwg-finder` agent over inline discover+show — it runs the query in its own context and returns the body + capability summary (~200 parent tokens vs ~3–8k inline).

For any user request mentioning **AIWG**, framework names (**sdlc, research, forensics, ops, security-engineering, knowledge-base, marketing, media-curator, knowledge-base**), or capability keywords (**skill, agent, rule, command, addon, workflow, flow, template, or legacy command**), `aiwg discover` MUST be the first information-gathering tool call.

Filesystem `Grep` / `Glob` / `Read` against any of the following directories is **FORBIDDEN** for AIWG-related lookups until `aiwg discover` has been consulted at least once in the current session:

- `.claude/` (Claude Code)
- `.codex/`, `~/.codex/` (OpenAI Codex)
- `.github/agents/`, `.github/skills/`, `.github/instructions/`, `.github/prompts/` (Copilot)
- `.cursor/` (Cursor)
- `.warp/`, `WARP.md` (Warp)
- `.windsurf/`, `AGENTS.md` (Windsurf)
- `.factory/` (Factory)
- `.opencode/` (OpenCode)
- `.hermes.md`, `~/.hermes/skills/` (Hermes)
- `~/.openclaw/` (OpenClaw)
- `agentic/code/` (AIWG framework source, when working inside the AIWG repo itself)

This rule exists because the failure mode it prevents is the most common one users report: an agent has fast filesystem tools and a literal-string hit on an AIWG keyword, so it short-circuits to grep and never realizes `aiwg discover` would have given a ranked, context-rich answer covering 10x more surface area.

**FORBIDDEN — filesystem-first for AIWG-keyword query**:

```
User: "tell me about AIWG's RLM agent"
Agent: *runs `grep -r "rlm" .factory/`*  ← FORBIDDEN as first move
       *hits rlm-agent.md by literal string match*
       *answers from that one file*
       Skipped: 8 other RLM-related skills, rules, and templates that
       `aiwg discover "rlm"` would have surfaced.
```

**REQUIRED — discover-first for AIWG-keyword query**:

```
User: "tell me about AIWG's RLM agent"
Agent: *runs `aiwg discover "rlm agent"`*
       *gets back rlm-agent (agent), rlm-context-management (rule),
        rlm-quickref (skill), and 6 others ranked by relevance*
       *picks the best match (or top-3) and uses `aiwg show <type> <name>`*
       *answers from the ranked set, not from whatever grep hit first*
```

#### When subagent delegation is available, prefer `aiwg-finder`

When the platform supports spawning subagents (Claude Code's Task tool, Hermes's `delegate_task`, etc.), dispatching to the `aiwg-finder` agent is preferred over self-service `aiwg discover` + `aiwg show` in the parent context. The finder agent:

- Runs the discover query in its own context (parent context stays clean).
- Returns the selected artifact body plus a one-paragraph capability summary.
- Costs ~200 parent tokens vs. ~3,000-8,000 for the full discover+show transcript inline.

Pattern (Claude Code, but symmetric on other subagent-capable platforms):

```
Task(subagent_type="aiwg-finder", prompt="find the skill or agent for: <user's intent>")
```

#### When you may skip the discover query (same as Rule 4 below — kept here for proximity)

You may skip the index query when:
- The user named a specific skill or legacy command alias (`flow-deploy-to-production`, `/flow-deploy-to-production`, `aiwg use sdlc`).
- The capability is clearly outside AIWG's scope (general programming, weather, translation).
- You've already queried for the same need within the current session.
- The kernel quickref directly lists the skill the user needs.

In every other case, **discover first**.

### Rule 2: Query the Index Before Improvising

Even when you *can* build from scratch, check first for a curated skill — it encodes templates, gate criteria, multi-agent patterns, and framework conventions an ad-hoc version misses. (e.g. "generate a SAD" → `aiwg discover "create SAD"` → artifact-orchestration + the architecture-evolution flow, not freehand.)

### Rule 3: Quickrefs Are a Filter, Not a Limit

Kernel quickrefs are orientation, not an exhaustive list. When a need isn't verbatim in a quickref, query the index — don't assume the framework lacks the skill. Don't enumerate from memory.

### Rule 4: When to Skip the Query

You may proceed without querying the index when:

- The user named a specific skill or legacy command alias (`flow-deploy-to-production`, `/flow-deploy-to-production`, `aiwg use sdlc`)
- The capability is clearly outside AIWG's scope (e.g., "what's the weather", "translate to French", general programming questions unrelated to AIWG)
- You queried for the same need within the current session and the result is in working memory
- The kernel quickref directly lists the skill the user needs (in which case you've already done the lookup mentally)

### Rule 5: Discover → Show Is the Canonical Access Pattern

When `aiwg discover` returns a path, fetch the body with `aiwg show <type> <name>` — **never** `find`/`ls`/`Glob`/`Grep`/`Read` on the discovered path. `discover` is the lookup; `show` is the fetch; they compose. You should never navigate AIWG's storage layout.

```bash
aiwg discover "deploy to production"        # ranked candidates with paths
aiwg show skill flow-deploy-to-production   # streams the SKILL.md body
```

### Rule 6: When Skill Invocation Errors, Don't Fall Back to the Filesystem

If the platform's native Skill tool rejects a name (most AIWG skills aren't kernel-listed — expected), the fallback hierarchy is: (1) **primary** `aiwg show <type> <name>` (fetches via the index regardless of disk location); (2) `aiwg show skill <name> --json` (path + content envelope, for forwarding to a sub-agent); (3) **last resort, only if the `aiwg` CLI is broken** read the canonical corpus at `$AIWG_ROOT/agentic/code/frameworks/<framework>/skills/<name>/SKILL.md` or `$AIWG_ROOT/agentic/code/addons/<addon>/skills/<name>/SKILL.md`. **`find`/`ls`/`Glob` against `<provider>/skills/` are never correct** — they reflect only the kernel deploy mirror, not the full surface.

### Rule 7: Surface the Top Match, Don't Hide the Search

When you query, tell the user and name the candidate(s) with a one-line capability summary, so your reasoning is auditable and they can redirect.

## Query Patterns

```bash
aiwg discover "audit the supply chain"        # by capability
aiwg discover "validate" --type skill         # by type filter
aiwg discover "..." --json --limit 3          # token-tight; stable schema for sub-agents
```

## Recovery

- **Never queried**: STOP → `aiwg discover "<need>"` → read capabilities → `aiwg show` → apply.
- **Queried then went to the filesystem**: stop, fetch via `aiwg show` (the path is `$AIWG_ROOT`-anchored; no need to `find` it).
- **Skill tool errored on a non-kernel skill**: take the name+type from discover, `aiwg show <type> <name>`, apply its instructions yourself.
- **`aiwg` CLI broken**: read the corpus directly, then repair via `aiwg-doctor` → `aiwg-refresh` (the always-loaded self-maintenance kernel skills exist for exactly this).

Better to query late than not at all.

## Interaction with Other Rules

- **research-before-decision** — for AIWG-internal content, "research" means `aiwg discover` + `aiwg show`, NOT filesystem `Read`/`Glob`/`Grep`.
- **instruction-comprehension** — pass the *parsed* intent to discover, not ambiguous verbatim words.
- **human-authorization** — never invoke a destructive skill without authorization, even on a discover match.
- **god-session** — discover is one focused step; decompose complex multi-skill flows rather than absorbing them.

Universal across all AIWG providers — the `discover` subcommand works against the artifact index regardless of which provider deployed the skills.

## Checklist

Before declining a user request on the grounds that AIWG can't do it, verify:

- [ ] Did I run `aiwg discover "<paraphrased need>"`?
- [ ] Did I check the right `--type` filter (skill, agent, rule, or command only for legacy bridge lookup)?
- [ ] Did I read the top result's `capability` description, not just its name?
- [ ] If multiple results were close, did I report them to the user?
- [ ] Have I confirmed the need is genuinely outside AIWG's scope?

If any answer is "no" — query before answering.

After `aiwg discover` returns a match, before reading anything from disk, verify:

- [ ] Did I use `aiwg show <type> <name>` to fetch the body?
- [ ] If the platform Skill tool errored, did I fall back to `aiwg show` (not `find` / `ls` / `Read`)?
- [ ] If `aiwg show` is somehow unavailable, am I reading from `$AIWG_ROOT/agentic/code/...` (the canonical corpus), not from a `<provider>/skills/` deploy mirror?

If any answer is "no" — you're navigating the filesystem when you should be using the CLI. Stop and run `aiwg show`.

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/research-before-decision.md
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/instruction-comprehension.md
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/skills/aiwg-utils-quickref/SKILL.md
- Issue #1215 (this rule), parent epic #1212

---

**Rule Status**: ACTIVE
**Last Updated**: 2026-05-09
