# Cowork limitations

PM OS targets Claude Code as its primary surface — the model is best, the plugin loader is most predictable, and the slash UX is namespace-prefixed which keeps things unambiguous. Cowork is fully supported but has a few rough edges worth knowing before you bet on it.

These are all Cowork product limitations, not PM OS bugs. We document them here so you can work around them with eyes open.

---

## 1. No `/pm-os-upgrade` slash for plugin upgrades

In Claude Code, you can run `/pm-os:pm-os-upgrade` (or `bash bin/upgrade.sh`) to upgrade your PM OS install in place. The script detects your existing workspace shape, refuses the wrong-tool ZIP with a friendly error, and merges new system files while preserving Context and Work.

**Cowork has no plugin upgrade slash.** Plugin upgrades go through Cowork's UI:

1. Download the new `pm-os-cowork-X.Y.Z.zip`.
2. Re-upload the inner `pm-os.zip` via Customize → Upload custom plugin. Cowork overwrites by plugin name.
3. If the workspace structure changed (rare), manually copy new `workspace/` content into your existing project folder.

We can't make this seamless from inside the plugin — Cowork doesn't expose a "trigger plugin re-install" API to skills.

---

## 2. Dropdown doesn't show plugin namespace in the title

When you type `/` in Cowork, the autocomplete dropdown shows bare skill names — `start`, `strategy`, `feedback`, etc. — without the plugin namespace prefix that Claude Code's UI includes.

This means **generic-named skills can't be told apart from other plugins' skills with the same name**. If you have both PM OS and another plugin that ships `start`, you see two `start` entries with no easy way to know which is which.

PM OS works around this by:

- Prefixing the 10 most-generic system skills with `pm-os-` (`pm-os-start`, `pm-os-tidy`, `pm-os-feedback`, etc.) so they self-identify.
- Keeping the 13 user-facing slashes specific (`pm-help`, `pm-status`, `pm-review`, `pm-os-*`, `import-ai-memory`) so the dropdown is unambiguous.
- Letting workflow names (`strategy`, `research`, etc.) and reusable skills (`find-the-strategic-crux`, etc.) stay bare — they're PM-domain-distinctive or descriptive enough that collisions are unlikely.

If Cowork later shows plugin source in the dropdown, the `pm-os-` prefix becomes redundant — we'll drop it in a future major version.

---

## 3. Session-start hooks may not render visibly

PM OS ships two `sessionStart` hooks: `tidy-reminder` (offers to run `/pm-os-tidy` when your Context is drifting) and `drip-reminder` (offers a daily context question via `/pm-os-daily-drip`).

In Claude Code, these emit `[SESSION-START DIRECTIVE — …]` payloads that you see immediately as the AI's first action. In Cowork, the same payloads execute server-side but **may not render as separate messages** in the chat UI. You may see the effect (the AI offering to run `/pm-os-tidy`, for example) without the visible directive message.

This is a Cowork rendering choice — the hooks still run, the AI still acts on them. Just expect slightly different UX than the CLI.

---

## 4. Skills with `name:` ≠ directory name show the directory name

Per the official skill spec, plugin slash invocation uses the directory name. The `name:` frontmatter field is a display label that some UIs render and some don't.

A few PM OS skills carry historical `name:` values that don't match their directory:

| Directory | Frontmatter `name:` |
|---|---|
| `pm-help` | `help` |
| `assumptions` | `assumption-mapping` |
| `coaching` | `pm-coaching` |
| `decisions` | `make-great-decisions` |
| `measure` | `measure-what-matters` |
| `meeting` | `meeting-mastery` |
| `opportunity` | `opportunity-mapping` |
| `pm-review` | `multi-perspective-review` |
| `research` | `research-to-feature` |

In Cowork's current dropdown, the **directory name wins** — you'll see `pm-help`, `coaching`, `decisions`, etc. The longer "display" names live on as labels in case future UIs render them.

This means the slash you type matches what's in the dropdown — no surprises. We tested this with a 2-skill probe plugin during the v2.1.0-beta.1 build to confirm.

---

## 5. Cowork's plugin validator is stricter than `claude plugin validate`

The official CLI tool `claude plugin validate` accepts plugins that Cowork's UI validator rejects. We've hit:

- **Non-standard frontmatter fields** — Cowork rejects any field outside the documented allowed set (`name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context`, `agent`, `hooks`, `paths`, `shell`). CC's CLI tolerates extras silently.
- **YAML parse errors** — Cowork hard-rejects any skill with malformed frontmatter. CC's CLI now flags them with the same message, but older versions silently dropped metadata.

PM OS's release pipeline runs `claude plugin validate` against the actual Cowork-bundled plugin (extracted from the inner `pm-os.zip`), not just against the source layout. This catches most issues before customers see them. If you ever hit a Cowork validation failure on a PM OS release, that's our bug, not yours — open an issue.

---

## 6. Marketplace org distribution not supported

If you want to share a Cowork plugin across your whole organization, you currently can't — each user uploads `pm-os.zip` individually via Customize. There's no org-marketplace concept yet.

For team distribution, your options are:

- Send each PM the customer-access link to download the ZIP.
- Have one PM install + share a screen-recording walkthrough for the others.

We'll revisit this when Cowork ships org marketplaces.

---

## 7. File system access boundaries

Cowork has filesystem access to your project folder. PM OS skills assume they can:

- Read `📂 Context/COMPANY.md` and the other 4 mandatory files.
- Read `knowledge/` content on demand.
- Read `templates/` and `examples/`.
- Write to `📂 Context/Work/{project-slug}/`.

If Cowork's filesystem permissions are restricted, some skills may not work as documented. Make sure your Cowork project folder is the one you uploaded the `workspace/` contents into.

---

## 8. MCP server cold-start

The bundled `lenny-podcast` MCP server runs on Render's free tier. After 15 minutes of inactivity, Render sleeps the dyno. **First Lenny call in a fresh session waits ~15–30 seconds** while the server wakes. Subsequent calls are sub-second.

This is documented in the main README + AGENTS.md. Mostly invisible unless you're explicitly searching transcripts — Claude may also autoload Lenny mid-conversation if a podcast topic comes up, and you'll feel the latency then.

---

## What's not on this list

These are things some users expect but aren't Cowork-specific:

- **`/pm-help` shows fewer entries than the full list.** Expected — `pm-help` only shows skills marked as user-facing in the registry, not all 236.
- **Reusable skills don't appear when you type `/`.** Most reusable skills have `disable-model-invocation: false` and rely on Claude pulling them in automatically based on `description:` matches. They surface in autocomplete but aren't designed to be typed.
- **`📂 Context/Work/.hook-state/` is empty.** Created on first hook fire. Not a bug.

---

## What we're tracking

- Org marketplace support, when Cowork ships it.
- Plugin source in the dropdown title (would let us drop the `pm-os-` prefix).
- Better hook UX in the Cowork chat.
- A way to trigger plugin re-install from inside a skill.

If you hit a Cowork limitation we haven't documented, open an issue or send `/pm-os-feedback`.
