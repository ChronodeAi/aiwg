# WORKSPACE.md migration notes

This migration is optional and backward compatible. Preview it with
`aiwg workspace-context migrate --dry-run`; no provider file is rewritten until
`--apply` is supplied. Review the reported duplicate, conflict, scope, and
possible-credential findings first.

## Scope: what a provider-named file means

Migration classifies a context source by filename. `CLAUDE.md` routes to the
`claude` scope, `AGENTS.override.md` to `codex`, and their operator content lands
in `.aiwg/context/providers/<name>.md`.

**Content under `.aiwg/context/providers/` is loaded by that provider only.**
Project-neutral methodology — conventions, artifact contracts, naming rules,
verification discipline — belongs in `WORKSPACE.md`'s Project Context section,
where every provider reads it.

This matters because `CLAUDE.md` was the conventional home for project context
long before `WORKSPACE.md` existed, so a project adopting the canonical graph often
has its *main* contract in a provider-named file. Routing that on filename alone
narrows it to one provider — and because nothing errors, `doctor` reports healthy
afterwards while a non-Claude session in the same repository no longer reaches it.

`migrate --dry-run` therefore reports, per source, how much operator content moves
and to which scope:

```
  CLAUDE.md: 28,224 chars -> .aiwg/context/providers/CLAUDE.md (claude-only)
  WORKSPACE.md: 117 chars -> WORKSPACE.md (project-neutral)
  REVIEW CLAUDE.md carries 28,224 chars of operator content and is scoped to claude-only by filename.
```

A `REVIEW` line is a decision, not an error. If the content is genuinely
Claude-specific, apply as planned. If it is project-neutral, move it into
`WORKSPACE.md`'s Project Context section *before* applying; the audit then
classifies it as neutral and every provider keeps reaching it. The same data is
available as `plan.routing` and `plan.scopeReview` under `--json`.

After applying, commit `WORKSPACE.md`, provider bootstraps, and attributed files
under `.aiwg/context/providers/`. Transaction preimages under
`.aiwg/context-migrations/` are recoverable local evidence and support
`aiwg workspace-context rollback`. Nested `AGENTS.md`, `CLAUDE.md`, and
`WARP.md` files are not flattened or rewritten.

If an existing `WORKSPACE.md` has no AIWG ownership markers, routine generation
leaves it untouched. The explicit migration command adopts it into the protected
operator region and records a transaction before replacing provider adapters.

For a complete existing-project adoption, use
`aiwg regenerate --existing-project --dry-run`, review the exact synthesized
project block and target list, then rerun with `--apply`. This branch includes
the generated root and normalized AIWG context in the same manifest, migrates an
active `AGENTS.override.md` before replacing it with a WORKSPACE-first bootstrap,
and prints the exact rollback command. It rejects partial-write flags, possible
credentials, and unresolved directive conflicts.
