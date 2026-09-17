# Migrate Grok Bot fleets from the Cursor workaround

**Audience:** operators who previously ran `aiwg use … --provider cursor` so Grok Bot could see AIWG artifacts.  
**Related:** [#196](https://github.com/jmagly/aiwg/issues/196), [#210](https://github.com/jmagly/aiwg/issues/210), [`docs/architecture/adr-grokbot-provider-target.md`](../architecture/adr-grokbot-provider-target.md)

## What changes

| Fleet | Provider flag | Notes |
|---|---|---|
| **Grok Bot** (multi-agent desktop assistant) | `--provider grokbot` | First-class id; **no** bare `grok` alias |
| **Cursor IDE** | `--provider cursor` | Unchanged — keep Cursor fleets on `cursor` |

The Cursor workaround deployed into `.cursor/` paths Grok Bot does not auto-load and surfaced Cursor reload wording. `grokbot` writes a discover-first `AGENTS.md` bridge (+ shared `WORKSPACE.md` / `.aiwg/AIWG.md`) and never targets `.cursor/**`.

## Migration steps (Grok fleets)

1. Confirm AIWG ≥ the release that includes the experimental `grokbot` provider (landed via #211 on `main`).
2. From each project:

   ```bash
   aiwg use all --provider grokbot --dry-run
   aiwg use all --provider grokbot
   ```

3. For user-scope / global skill copies, set an **absolute** skill root first (AIWG does not invent `~/.grokbot`):

   ```bash
   export AIWG_GROKBOT_SKILLS_DIR=/absolute/path/to/grokbot/skills-or-workflows
   aiwg use all --provider grokbot --scope user
   ```

4. Start a **new Grok Bot agent chat** (or re-read skills). Do not expect Cursor “reload window” wording.
5. Optionally remove obsolete `.cursor/` AIWG copies **only** if that tree was created solely for the Grok workaround and is not used by Cursor IDE on the same machine.

## Cursor IDE fleets

No migration. Continue:

```bash
aiwg use all --provider cursor
```

## Verify

```bash
aiwg doctor --provider grokbot
aiwg status --probe
```

Provider status may still be `experimental` until #210 stable promotion evidence (cross-platform PUW) lands.
