---
name: pm-os-agent-builder
description: >-
  Use when the user wants to create, author, or scaffold their own custom
  agent or subagent, says 'make my own agent', 'build me an agent', or
  types /agent-builder. Not for finding an existing PM skill that already
  does the job (`pm-os-skill`) or touring what the system already has
  (`pm-help`).
---

# /agent-builder

Interview the user, then generate a working custom agent for **their** harness and place it where `/upgrade` can never touch it. Every agent is a **contract** — one job, correctly scoped — and it only exists if it **earns its context**.

Three reference files hold the distilled research; read each when its step arrives, not before:
- [`references/harness-specs.md`](references/harness-specs.md) — per-harness file format, paths, gotchas (Step 6)
- [`references/cadence.md`](references/cadence.md) — long-running, recurring, goal-driven execution (Step 4)
- [`references/idea-gallery.md`](references/idea-gallery.md) — a curated menu of agents that earn their context (Step 2)

## Step 1 — Harness

Establish which harness the agent runs in: **OpenAI Codex/ChatGPT**, **Claude Code**, **Cursor**, or **Cowork**. Directory signals are weak — `.codex/`, `.claude/`, and `.cursor/` may all be generated or linger from prior sessions, so presence is a hint, not proof. Infer only when the active runtime is unambiguous; otherwise ask one question with four options.

Done when harness named and confirmed.

## Step 2 — Fit

Decide whether this should be a subagent **at all**. A subagent earns its context only if it clears one bar:

- **Parallelism** — several run at once (a review panel).
- **Protects the thread** — absorbs heavy, cluttered work (archival digging, corpus synthesis) that would junk the main context.
- **External reach** — pulls live data via MCP the local files don't have.
- **Cadence** — genuinely wants to recur (handled in Step 4).

If it clears none, it's a **command or skill, not a subagent** — say so and stop building an agent. Evidence: even the 23K-star `pm-skills` marketplace ships red-team, pre-mortem, and competitive-analysis as single-thread *commands*, not subagents. A single-lens, single-pass job does not need an isolated context; wrapping it in one adds latency and loses nothing.

If the user has no job in mind, offer the [idea gallery](references/idea-gallery.md) — filter it to their harness (Step 1) and whatever MCPs they have connected, and let them pick a starting point.

Done when the idea clears a bar (proceed), or it's been redirected to a command/skill (stop).

## Step 3 — Job

Interview for the agent's **one job**. Pull, don't assume. Batch into as few turns as possible:

- **Trigger** — what makes it fire? (a phrase, a task type, "after X")
- **Reads** — what may it look at?
- **Writes** — does it change files, or is it read-only? (default read-only unless the job needs writes)
- **Model + effort** — heavy reasoning/high effort or economical/mechanical/low effort? Default: inherit from the parent unless the target host has a verified model slug.

One job per agent. If the answers describe two jobs, split them.

Done when trigger, read-scope, write-scope, and model each pinned in one sentence.

## Step 4 — Cadence

Ask **how often it runs**: one-shot, recurring, or goal-until-done? This decides *whether you even write an agent file*. See [`references/cadence.md`](references/cadence.md).

- **One-shot async** → an agent file (background execution). Continue.
- **Recurring** ("every hour/morning/week") → **not an agent file.** Produce a host or external schedule that invokes a prompt: ChatGPT Scheduled Task, Cursor Automation, Cowork Scheduled Task, or an external scheduler. Cadence is never agent frontmatter.
- **Goal-until-done** → an agent/loop **body** stating a checkable success criterion that iterates until met — no harness has a platform-enforced "goal mode."
- **Self-scheduling** → unsupported everywhere. Redirect to recurring.

The trap: a subagent **cannot schedule itself** (no `ScheduleWakeup`, no self-mutating cron). A subagent that "loops" is a category error — build the schedule around it.

Done when cadence named; if recurring/self-scheduling, the user knows an agent file alone won't do it.

## Step 5 — Tools & MCP

Map the job to a **minimum** tool allow-list. Omitting the tool field inherits everything — prefer a tight list.

**Be proactive about MCP.** If the job names or implies a connected service — GitHub, Linear, Notion, Atlassian, Perplexity/web, analytics — surface it: *"This agent triages issues; the Linear MCP is available. Want it to work on live issues?"* Confirm the server is actually configured and authenticated. Codex uses its config/plugin MCP layer; Cowork uses Connectors; other hosts have their own enablement step.

Done when tool list decided; every MCP the job implies either wired in or explicitly declined.

## Step 6 — Draft

Read [`references/harness-specs.md`](references/harness-specs.md) for the target harness, then write the agent file to that exact frontmatter schema. Match the house `Contract` shape (Inputs / Allowed reads / Writes / Output format) so the agent's boundaries are legible. Keep the body focused on the one job.

Done when a complete agent file valid for the target harness's schema (required fields present, tools/model fields correct for that harness).

## Step 7 — Place

Write the file to the **upgrade-safe home** for that harness (see specs file — Codex personal: `~/.codex/agents/`, Codex project: `.codex/agents/`; Claude Code: `~/.claude/agents/`; Cursor: `.cursor/agents/`; Cowork: a standalone user plugin). Never write a user's agent into the PMOS addon or ``, which are managed distribution sources.

Then tell the user, plainly: where it landed, how the harness selects or invokes it, and which update mechanism owns that path.

Done when file written to the upgrade-safe path, and the user told the path + how to invoke.
