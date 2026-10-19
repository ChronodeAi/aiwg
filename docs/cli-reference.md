---
audience: agent-operator
publication: agent-reference-redirect
stable_id: aiwg.agent-reference.cli.root-compat
---

# CLI Reference Moved

The authoritative agent and automation CLI reference is now
[`docs/cli/reference.md`](cli/reference.md).

This compatibility pointer remains in installed packages for older agent
artifacts. General users should follow
[Install, Connect, and Verify](getting-started/install-connect-verify.md).

## `aiwg rules` — operator rule pins

Pin full rule bodies to every request without editing canonical activation:

```bash
aiwg rules pin <rule>... [--tier critical,high] [--capability id,... | --group name]
aiwg rules pin --capability aiwg-utils [--all-tiers]
aiwg rules pin --all
aiwg rules unpin <rule>...                 # also accepts the same selector flags
aiwg rules pinned [--capability id] [--json]
aiwg rules group set <name> <capability>...
aiwg rules group list [--json]
```

Mutation flags: `--project` (default), `--user`, `--dry-run`, `--no-deploy`,
`--json`, `--allow-over-budget`. No prompts are required. Comma-separated tier
and capability lists are supported. Tiers are `critical`, `high`, `medium`,
`low`; omitted tiers include every tier. Selectors match conjunctively within an
entry and disjunctively across entries. Overlapping matches deploy once.
`unpin` removes exactly a selector, independent of list order. Dry runs show
rules and per-provider startup bytes; budget failures preserve prior config and
deployment. See [operator rule pins](configuration/aiwg-config.md#operator-rule-pins)
for config shape, scope precedence, and budget behavior.
