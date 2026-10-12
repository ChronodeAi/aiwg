# Grok Bot cloud session — global AIWG install (default path)

**Date:** 2026-09-16 (America/New_York)  
**Host:** Grok Bot shared cloud computer  
**AIWG:** 2026.9.15 @ `main` (`d92d60c5c`) via `/tmp/aiwg` source install

## Default model

Install AIWG into the cloud computer (and policy/repo workspaces) so every Bot picks it up like other harnesses — **not** via inventing `~/.grokbot` or a Steward Bot for mere loading.

Steward / bootstrap Bot is only for mutating Grok-native objects (routines, CreateAgent, connectors) — see #209.

## Durable skill root

```bash
export AIWG_GROKBOT_SKILLS_DIR=/home/box/.local/share/aiwg/grokbot-skills
```

Persisted in:
- `~/.config/environment.d/aiwg-grokbot.conf`
- `~/.bashrc` (default export)

## Commands run

```bash
export PATH="$HOME/.local/bin:$PATH"
export AIWG_GROKBOT_SKILLS_DIR=/home/box/.local/share/aiwg/grokbot-skills
aiwg use all --provider grokbot --scope user
cd /home/box/aiwg-policy && aiwg use all --provider grokbot
cd /home/box/aiwg-policy && aiwg regenerate --apply
```

## Result

- 26 skills mirrored to `$AIWG_GROKBOT_SKILLS_DIR`
- No `~/.grokbot` / `~/grokbot-skills` invented
- Policy workspace AGENTS.md / WORKSPACE.md regenerated for AIWG binding
- Reload: start a new agent chat or re-read skills (AIWG does not claim live refresh)

## Verify

```bash
aiwg status --probe --json --scope user
aiwg doctor --provider grokbot
aiwg discover "address issues"
```
