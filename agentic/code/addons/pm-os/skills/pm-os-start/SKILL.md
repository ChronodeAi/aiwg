---
name: pm-os-start
description: >-
  Use when the user wants to onboard, set up their PM OS Context files, or
  says '/start'. Not for a one-time paste-back import from another AI
  assistant standalone (`import-ai-memory` — this skill invokes it as one
  branch) or merging a version upgrade into an existing workspace
  (`pm-os-upgrade`).
---

# /start — Onboard

Read [`references/onboarding-phases.md`](references/onboarding-phases.md) for the exact Q&A script when you reach each phase below — don't load it up front, load it phase by phase as the flow actually gets there.

## Structured question contract

Use the host's native structured user-input surface for every multiple-choice question when one is available. In OpenAI Codex/ChatGPT this may be exposed as a structured input request; in other supported hosts it may have a different tool name. Batch questions only when the active tool explicitly supports batching and multi-select.

If the host does not expose structured input in the current mode, ask one concise conversational question with lettered options and wait for the answer. Never invent or call a tool that is not present in the active runtime.

**Free text:** Only use free-text questions for inputs that genuinely cannot be structured: company name, website URL, one-line product description, and stakeholder personal details.

## Entry

Welcome the user warmly. Say: "This takes about 5–10 minutes. Once done, every command, framework, and skill in the system is tailored to your specific situation — so it's worth doing properly."

**Telemetry consent gate:** Explain that PMOS can send a short setup-progress summary (company name, industry, product stage, team size, goals — not full free-text answers) to the configured webhook for support and license analytics. Ask: "Enable setup progress telemetry for this onboarding session? (yes/no)" Default to **no** unless the user explicitly opts in. Keep the answer as `telemetry_consent` for this flow; never infer consent from continued use. See `feedback-config.md` for details.

**Three-way entry menu — ask unconditionally** (first-time users get the same choice). Read `📂 Context/COMPANY.md` first (used only to colour the "Update" framing — the menu fires regardless).

Use the active host's structured input surface, or the lettered conversational fallback:
- A. Update my context (Q&A flow — phases below)
- B. Import context from another AI assistant (Claude, ChatGPT, Gemini) — paste-back, ~1–2 min
- C. I just want to see what the system can do → run `/help` instead

**If B:** read and execute `import-ai-memory`'s `SKILL.md` in full as a sub-flow (skip its own Step 9 telemetry — this entry path owns the `setup:import` ping, fired below, right after the sub-flow returns).

When the sub-flow returns:

Only if `telemetry_consent` is yes, read `feedback-config.md` to get `webhook_url`, say *"Logged your import."*, and run:
```bash
curl -s -L -X POST "[webhook_url]" \
  -H "Content-Type: application/json" \
  -d "{\"event\": \"setup:import\", \"company\": \"[best-known company or empty]\", \"sources_used\": [\"<source1>\", \"<source2>\"], \"source_count\": [N], \"conflicts_resolved\": [N], \"files_pre_filled\": [N], \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
```

If consent was not granted, skip the network call and say *"Import completed locally; telemetry is off."* If curl is unavailable or fails after consent, silently continue.

Then re-read each `📂 Context/*.md` file; for any still holding a placeholder, drop into that file's phase below (skip phases the import already populated — their setup pings still fire from the phase itself, just less often since some files arrive pre-filled).

**If A or first-time setup without picking B:** proceed through all four required phases below.

Done when the entry menu has been answered and the corresponding branch (import sub-flow, or Phase 1) has started.

## Phases

Each phase drafts one Context file from a short Q&A, shows the draft, and saves only on explicit confirmation. It fires the phase telemetry ping only when `telemetry_consent` is yes. Full scripts: [`references/onboarding-phases.md`](references/onboarding-phases.md).

| Phase | Required? | Writes | Collects |
|---|---|---|---|
| 1. Company | Required | `📂 Context/COMPANY.md` | Name, website, public/private status, web-searched industry context |
| 2. Product or Capability | Required | `📂 Context/PRODUCTS.md` | Product shape, description, stage, top challenges |
| 3. Role & Team | Required | `📂 Context/TEAM.md` | PM level, team size, biggest friction |
| 4. Goals | Required | `📂 Context/GOALS.md` (+ optionally `CONSTRAINTS.md`) | Focus areas, 90-day win definition |
| 5. Stakeholder Profiles | Optional | `📂 Context/STAKEHOLDERS.md` | 1–3 stakeholder communication/decision profiles |
| 6. Communication Style | Optional | `📂 Context/MY_STYLE.md`, `coaching-settings.json` | Output format, depth, tone, coaching intensity |
| 7. First Project | Optional | `📂 Context/Work/{slug}/`, `.current` | First project folder |

Phases run in order, 1 through 7, each offered only after the previous one saves or is skipped. Done when Phase 4 has saved `GOALS.md` and phases 5–7 have each been offered and either completed or skipped.

## Wrap-up

After all context is saved, output a personalised finish screen naming one recommended next command (matched from the challenges/win tags — mapping table and exact template in [`references/onboarding-phases.md`](references/onboarding-phases.md#wrap-up-personalised-finish-screen)), then offer to generate `📂 Context/Work/getting-started.md`.

Done when the finish screen has been shown and the getting-started guide has been confirmed, declined, or skipped.
