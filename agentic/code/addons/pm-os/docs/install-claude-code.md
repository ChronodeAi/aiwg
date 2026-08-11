# Install PM OS in Claude Code

PM OS runs natively in Claude Code via the plugin system. Auto-discovery — no manual configuration.

---

## Requirements

- Claude Code CLI installed and authenticated. See [Claude Code quickstart](https://code.claude.com/docs/en/quickstart).
- Git. (Optional but recommended for keeping in sync with updates.)
- A capable model selected in your session.

---

## Install

1. From your customer-access link, download `pm-os-claude-code-<version>.zip`.
2. Extract it into the folder where you want PM OS to live.
3. `cd` into that folder and run `claude`.

When Claude Code starts:

- It reads `.claude/settings.json`, which declares an `extraKnownMarketplaces` entry pointing at `.` (the repo root).
- The marketplace at `.claude-plugin/marketplace.json` lists one plugin (`pm-os`) sourced from `./plugins/pm-os`.
- The `enabledPlugins` block (`"pm-os@pm-os": true`) flips that plugin on at session start.
- Skills, agents, hooks, and the MCP server (`lenny-podcast`) auto-register.

---

## Verify install

In your fresh session, run:

```
/plugin list
```

Expected: `pm-os` enabled.

```
/mcp list
```

Expected: `lenny-podcast` registered. First call after idle wakes the dyno (~15s) — see the Lenny note below.

Type `/` to open autocomplete. You should see entries prefixed with `pm-os:` — the 15 system skills, 11 workflow skills, and 204 reusable skills under one namespace.

---

## Your first session

```
/pm-os:pm-os-start
```

Walks you through filling `📂 Context/COMPANY.md`, `PRODUCTS.md`, `GOALS.md`, `TEAM.md`, `CONSTRAINTS.md`. About 5 minutes.

Then ask something real:

```
I need to figure out what to prioritize for Q2. Here are the 6 things on the table: …
```

The AI reads your filled-in Context files before every response and shapes its answer accordingly.

---

## Skills don't appear

If autocomplete doesn't show `pm-os:` entries:

1. Reload: `/reload-plugins`
2. Confirm settings: `cat .claude/settings.json` — look for `"pm-os@pm-os": true` under `enabledPlugins`.
3. Confirm marketplace: `cat .claude-plugin/marketplace.json` — `source` should be `./plugins/pm-os`.
4. Run the official plugin validator: `claude plugin validate plugins/pm-os` — should pass with at most a single warning about plugin-root `CLAUDE.md` (cosmetic, not blocking).

If `/plugin list` shows `pm-os` as not enabled, check Claude Code's logs (`claude --debug`) — the most common cause is permission denial on `.claude/settings.json`.

---

## Lenny MCP first-call latency

`lenny-podcast` runs on Render's free tier. After 15 minutes of inactivity, the dyno sleeps. First request post-idle waits ~15–30 seconds while the server wakes. Subsequent requests are sub-second.

This means: the first time Claude tries to call `search_transcripts` in a fresh session, expect a noticeable wait. After that the server stays warm for the rest of your session.

Worth knowing because Claude may autoload Lenny mid-response if a podcast topic comes up — first hit will feel slow.

---

## Upgrading

To upgrade an existing PM OS install to a newer version:

```bash
cd /path/to/your/pm-os
git pull
```

Or for a workspace that wasn't installed from git:

```bash
bash bin/upgrade.sh --in-place .
```

The script preserves `📂 Context/`, `📂 Context/Work/`, and any custom plugins. Replaces `plugins/`, `knowledge/`, `templates/`, `examples/`, `bin/`, `AGENTS.md`, `CLAUDE.md`.

See [`upgrade.md`](upgrade.md) for the full upgrade flow and tool-mismatch handling.

---

## Uninstall

Delete the repo directory. Nothing else writes outside it.

If you want to keep your `📂 Context/` and `📂 Context/Work/` content, move those folders out first.

---

## Next

- [`install-cowork.md`](install-cowork.md) — same source, different distribution.
- [`install-cursor.md`](install-cursor.md) — Cursor's `.cursor/` shape.
- [`limitations-cowork.md`](limitations-cowork.md) — what Cowork doesn't yet support.
- [`upgrade.md`](upgrade.md) — version-to-version migration details.
