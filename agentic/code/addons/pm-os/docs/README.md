# PM OS Docs

`docs/` is part of the distributed PM OS package. It contains product-facing system documentation that helps users and agents run PM OS correctly.

## Contents

- `docs/rules-brief.md` — compact rule re-brief for long sessions.
- `docs/memory/` — V2 memory contract docs that future commands, validators, and agents can rely on.
- `docs/install-codex.md` — AIWG addon installation, native Codex hooks/agents, MCP opt-in, and verification.
- `docs/install-claude-code.md`, `docs/install-cursor.md`, `docs/install-cowork.md` — legacy/provider-specific installation guides.

## Distribution And Migration

PM OS ships memory **contracts and scaffolds**, not user memory.

- `docs/memory/` is system-owned and distributed. Future PM OS versions may update it during migration because it documents how the product works.
- `📂 Context/Work/` is user-owned and distributed only as an empty scaffold. Migration may create missing Work subfolders, but must not overwrite project artifacts or project memory.
- `📂 Context/Work/.current`, `📂 Context/Work/*/events.jsonl`, and `📂 Context/Work/*/DECISION-LOG.md` are user/company-specific and ignored by git.

## Rule Of Thumb

Docs in this folder should be stable enough to ship. Keep them focused on how PM OS works, how agents should use it, and what contracts future commands can rely on.
