# Cadence — long-running, recurring & goal-driven execution

Distilled from live-docs research (2026). Read when the job isn't a plain one-shot.

**The one rule that holds across all supported harnesses: cadence lives *around* the agent, not *inside* it.** No harness lets a subagent schedule its own re-run. Recurrence is a host or external scheduler that *invokes* a prompt. "Goal-until-done" is a checkable criterion in the body. So "build me an agent that loops every hour" means build a **schedule** that calls an agent, or a **body** that loops until a goal.

## The four cadences → what to actually produce

| Cadence | What the user means | Right primitive |
|---|---|---|
| **One-shot async** | "go do this big thing in the background" | an **agent file** (background execution) |
| **Recurring** | "every hour / morning / week" | an **external schedule** that calls a prompt — *not* an agent file |
| **Goal-until-done** | "keep going until X is true" | a **body** stating a checkable success criterion + loop; not a field |
| **Self-scheduling** | "the agent decides when to re-run itself" | **not supported anywhere** — say so; use recurring instead |

Ask which one at Step 4, then route. Don't emit an agent file for a recurring or self-scheduling ask.

---

## OpenAI Codex / ChatGPT desktop

- **One-shot async** → a native Codex subagent. The parent can spawn independent roles in parallel and inspect or steer them from the agent panel.
- **Recurring** → a ChatGPT Scheduled Task when that surface is available, or an external scheduler that starts a Codex prompt/non-interactive run. It is not a custom-agent TOML field.
- **Goal-until-done** → state an externally checkable success criterion and bounded verification loop in the task/body. The parent remains responsible for approvals and completion judgment.
- **Hard constraint** → a Codex subagent inherits the parent permission posture and cannot create a future run merely through its agent definition.

---

## Claude Code

- **One-shot async** → `background: true` frontmatter (already the default v2.1.198+). A normal subagent that runs to completion and returns a result.
- **Recurring** → a **cron routine** (`/schedule` → `CronCreate`, a.k.a. Desktop Scheduled Tasks) with cron/webhook/GitHub-event triggers, ~1-hour minimum interval, fresh clone per run; **or** `/loop` for in-session recurring on an interval. Neither is a frontmatter field — you schedule a *prompt/command*, and it can invoke the agent.
- **Goal-until-done** → body states a checkable criterion and loops until met (the §4 goal-driven pattern). `ScheduleWakeup` self-paces the loop — **main-loop only**. `maxTurns` / `effort` bound cost.
- **Hard constraint** → a subagent **cannot** call `ScheduleWakeup` and cannot self-schedule. Recurrence and self-pacing live in the main loop or a routine, never inside the agent file.

## Cursor

- **Two "background" knobs — do not conflate:**
  - `is_background: true` (in `.cursor/agents/*.md`) = the subagent runs **async relative to its parent, in the same environment** (in-session concurrency). Not cloud. 🟡 Unreliable before ~3.1 — reinforce intent in the `description` too.
  - **Cloud/Background Agents** = a **remote VM** Cursor provisions; clones the repo, works on a git branch, opens a PR, runs while you're offline. A dispatch mode, not a frontmatter field.
- **Recurring** → native **Automations**: run a **cloud** agent on a **cron expression** or on GitHub/Slack/Linear/webhook events. Configured in the Automations UI / Cloud Agents API — **never in the agent file**, and **no local-IDE cron** exists.
- **Goal-until-done** → **no formal goal mode** (open feature request). Agents self-judge "done" + tests + human review. 🟡 ~25 tool-calls/run cap (≈200 in MAX), then it stops and offers Resume — version-dependent, not user-disableable.
- **Self-scheduling** → **no.** A run can't mutate its own Automation. Recurrence is external only (Automations or an external caller of the Cloud Agents API).

## Cowork

- **Long-running** → native: runs in the **cloud, async, resumable across desktop/web/mobile** ("close your laptop and Claude keeps going"). Notifies you on completion or when it needs input. **Max duration: undocumented** — don't promise "unlimited."
- **Recurring** → native **Scheduled Tasks** (`/schedule` skill or the Scheduled sidebar page): **hourly → weekly**, cloud-run even when your machine is off. **No cron / no sub-hour cadence.** Each run is a **fresh session**, not a persistent loop. Can't be tied to a local folder — uses connectors + account files.
- **Goal-until-done** → model-judged from your **outcome prose**; **no structured success-criteria field**. Encode explicit, checkable stop criteria in the skill text yourself.
- **Approval gate** → **not automatic.** Depends on the user's chosen mode (Manually approve / Auto / Skip all). Only **permanent file deletion** is always gated. Tell users to switch to "Manually approve" before consequential sends (email, purchases aren't auto-gated).
- **Authoring unit** → for long/recurring/goal work, author a **skill** (bundle in a plugin if it needs connectors/subagents). Cowork subagents are **internal parallelism**, not durable independent sessions — the long-running/resumable property belongs to the task, not the subagent. **Self-scheduling: unsupported/undocumented.**
