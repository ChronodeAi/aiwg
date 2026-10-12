---
name: import-ai-memory
description: >-
  Use when the user wants to import context from another AI assistant
  (Claude, ChatGPT, Gemini) via paste-back, has a saved memory dump to paste
  in, or says '/import-ai-memory'. Not for onboarding from scratch with
  guided questions (`pm-os-start`), explicit one-off capture of a decision
  or update (`pm-os-capture-memory`), or the slow one-question-a-day
  accretion loop (`pm-os-daily-drip`).
---

# /import-ai-memory

**Bootstrap.** Bootstrap PM OS context from another AI assistant in under two minutes. You give the user a canonical extraction prompt to paste into Claude, ChatGPT, or Gemini, accept their pasted response back, parse it deterministically, surface a per-file confirmation diff, and write to the right memory layer.

This command is exempt from the Context Guard so it works on a fresh clone before `📂 Context/COMPANY.md` and `📂 Context/PRODUCTS.md` are populated.

Done when every route in the parsed response has been shown to the user and confirmed, edited, or skipped — never written silently.

## Structured question contract

Use the active host's structured user-input surface for the source picker, per-file confirm/edit/skip choices, and the "add another source?" loop. Batch only when the runtime explicitly supports it. In Codex or another mode without structured input, present one concise lettered question in normal chat and wait for the response.

Free-text inputs (the paste itself and per-file edits) always come through normal chat.

## Usage

| Form | What it does |
| --- | --- |
| `/import-ai-memory` | Run the paste-back import sub-flow once (up to 3 sources per session) |

There are no subcommands. The flow is linear.

## Flow

### Step 1 — Privacy framing

Before asking anything, say (verbatim or close to it):

> "Here's how this works: I'll show you a short prompt to paste into Claude, ChatGPT, or Gemini. You paste their response back here. I'll show you a per-file preview before anything is written to your Context files. At the end, you can optionally send a short summary (company name, sources used, and counts — never the pasted content) to the configured support/license webhook. Telemetry is off unless you explicitly opt in. See `feedback-config.md`. Up to three sources per session."

Ask once: "Enable the optional import-summary telemetry for this session? (yes/no)" Default to no and retain the explicit answer as `telemetry_consent`.

### Step 2 — Source picker

Ask the user which assistant they're importing from using structured input when available, otherwise lettered options:

- A. Claude
- B. ChatGPT
- C. Gemini
- D. Other (Grok, Copilot, Perplexity, local model, manual notes)

Map the answer to one of the helper's `--source` values: `claude`, `chatgpt`, `gemini`, `grok`, `copilot`, `perplexity`, `local`, `manual`. If "Other", ask one follow-up structured question to pick the specific source.

### Step 3 — Show the extraction prompt

Read `docs/import-prompts/universal.md` and show its body to the user inside a fenced markdown block so they can copy it cleanly. Say:

> "Paste the block below into [picked assistant]. When you get its response, paste it back here in your next message."

Do not modify the prompt per source — it is universal by design.

### Step 4 — Accept the paste

The user's next message is the source AI's response. Treat the entire message body as the paste. Write it to a temp file:

```bash
PASTE_TMP="$(mktemp "${TMPDIR:-/tmp}/.pm-os-import.paste.XXXXXX")"
cat > "$PASTE_TMP" <<'PMOS_IMPORT_PASTE'
[paste content goes here verbatim]
PMOS_IMPORT_PASTE
```

If the message is obviously not a paste (one-line question, "I don't have anything", etc.), drop back to Step 2 and confirm intent — do not run the helper on noise.

### Step 5 — Run the parser/router helper

```bash
bash bin/memory/import-ai-memory.sh \
  --input "$PASTE_TMP" \
  --source "<picked-source>" \
  --existing-context-dir "📂 Context" \
  --json
```

The helper exits:
- `0` — preview JSON on stdout (even if `routes` is empty)
- `1` — validation failed (size, secrets, missing source, etc.) — show the `message` field to the user and offer to retry
- `2` — bad arguments (programmer error — surface verbatim and stop)

If the helper auto-detected a different source than the user picked (`auto_detected_source` ≠ `source`), surface the mismatch once and ask whether to trust the auto-detection or stick with the picker.

### Step 6 — Walk routes and confirm per file

For each entry in `routes[]`:

1. Compute the destination:
   - `context_file:<NAME>.md` → `📂 Context/<NAME>.md`
   - `user_memory` → `📂 Context/Work/.hook-state/user-memory.md`
   - `project_event:<slug>` → `📂 Context/Work/<slug>/events.jsonl`
2. Build a draft of what would be written. For Context files, draft the full file content (or the section to add, if the file already has content); for `user-memory.md`, build the single-line bullet; for project events, build the JSONL event object.
3. **Show the draft to the user.** If the entry has `conflict_with_existing` set to a non-null sample, show both values side-by-side and attribute them: "Existing: `<sample>`. New (from <source>): `<claim>`. Keep existing, replace with new, or merge?"
4. Ask the structured confirm/edit/skip question.
5. On confirm:
   - **Context files**: write atomically with the temp-then-rename pattern (same-directory `mktemp` + `mv`). Add YAML frontmatter provenance if the file is being created from scratch: `source_assistant`, `extraction_method: paste`, `imported_at` (UTC ISO8601), `content_hash` (the entry's `sha256:` digest).
   - **`user-memory.md`**: pipe the body through the existing helper — never bypass it. Write the bullet text (markdown body, one short section is fine) to a temp file first, then call:
     ```bash
     tmp="$(mktemp -t pm-os-import-XXXXXX.md)"
     printf '%s\n' "<bullet text>" > "$tmp"
     bash bin/memory/append-user-memory.sh --content-file "$tmp" --tag "ai-import" --source "<source assistant>" --json
     rm -f "$tmp"
     ```
   - **Project events**: pipe through the events helper. Build the event JSON with `source: ai_import`, `source_digest: <sha256:...>` so re-imports dedup automatically:
     ```bash
     bash bin/memory/append-events.sh --project-slug "<slug>" --event-json "<event>"
     ```
6. On edit: take the user's edit, recompute the digest, re-run the deduplication check, then confirm again.
7. On skip: move on to the next entry. Skipped entries are not written and not remembered across sessions.

### Step 7 — Show `personal_dropped` and `ambiguous`

After all `routes[]` are processed:

- If `personal_dropped[]` is non-empty, summarize: "I left N personal items unsaved (you can copy them yourself if you want them in `user-memory.md`)." Do not auto-write personal items.
- If `ambiguous[]` is non-empty, walk each one: "I wasn't sure where this belongs — [claim]. Save to Context, user-memory, project events, or skip?" Use the same confirm/write path as Step 6.

### Step 8 — Loop: add another source?

Ask: "Add another source? (Sources so far: N / 3)" Options:
- A. Yes, import from another assistant → back to Step 2
- B. No, I'm done → continue to Step 9

Hard cap at 3 sources per `/import-ai-memory` invocation. After the third, force exit to Step 9.

### Step 9 — Optional telemetry ping

Only when `telemetry_consent` is yes, read `feedback-config.md` to get `webhook_url`, say *"Logged your import."*, and run:

```bash
curl -s -L -X POST "[webhook_url]" \
  -H "Content-Type: application/json" \
  -d "{\"event\": \"setup:import\", \"company\": \"[best-known company or empty]\", \"sources_used\": [\"<source1>\", \"<source2>\"], \"source_count\": [N], \"conflicts_resolved\": [N], \"files_pre_filled\": [N], \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
```

If consent was not granted, skip the network call and say *"Import completed locally; telemetry is off."* If curl is unavailable or fails after consent, silently continue.

### Step 10 — Handoff

- If invoked from `/start`'s branch B: hand back to `/start` for any Context files that are still placeholders (the import didn't populate them).
- If invoked standalone: thank the user and recommend `/status` to see the populated context.

## Safety Rules

- **Preview before write.** Every entry passes through user confirmation. No silent writes — ever.
- **Universal-memory guards are non-negotiable.** Anything routed to `user-memory.md` MUST go through `bin/memory/append-user-memory.sh` so the existing size, secret, and prompt-injection guards fire.
- **Project-event guards are non-negotiable.** Anything routed to project events MUST go through `bin/memory/append-events.sh` so validation and locking fire.
- **No network calls inside the helper.** Telemetry curl is in this command file, not in `bin/memory/import-ai-memory.sh`.
- **Atomic writes for iCloud safety.** Context-file writes use same-directory `mktemp` + `mv`. Never write partial content in place.
- **Personal-content categories drop by default.** Demographics, Interests & Preferences, and Relationships do not auto-route to work files. Ambiguous items (e.g., a job title in Demographics) surface for user choice.
- **Hard cap at 3 sources per session.** Loop terminates after the third paste.
- **Prompt-injection risk is user-accepted.** The per-file confirmation step is the safety net. The user can see and edit every line before it lands.
