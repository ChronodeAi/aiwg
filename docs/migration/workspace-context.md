# WORKSPACE.md migration notes

This migration is optional and backward compatible. Preview it with
`aiwg workspace-context migrate --dry-run`; no provider file is rewritten until
`--apply` is supplied. Review the reported duplicate, conflict, scope, and
possible-credential findings first.

## Scope: where operator content lands

Provider startup files (`CLAUDE.md`, `AGENTS.md`, `AGENTS.override.md`,
`WARP.md`) are bootstrap surfaces: AIWG rewrites them to a managed bootstrap
that loads `WORKSPACE.md` and `AIWG.md`. Migration therefore ports the operator
content they carried into the protected `## Project Context` block in
`WORKSPACE.md`, verbatim and attributed, under a `### Migrated from <path>`
heading with the source checksum.

**`WORKSPACE.md`'s Project Context block is what every provider bootstrap
loads**, and both `aiwg use` and `aiwg regenerate` preserve it byte-for-byte.
Tables, procedures, and fenced code blocks survive the move intact.

This matters because `CLAUDE.md` was the conventional home for project context
long before `WORKSPACE.md` existed, so a project adopting the canonical graph
often has its *main* contract in a provider-named file. Routing that to
`.aiwg/context/providers/` on filename alone narrowed it to one provider — and
because nothing errors, `doctor` reported healthy afterwards while no bootstrap
imported the file at all (#2558).

`migrate --dry-run` reports, per source, how much operator content moves:

```
  CLAUDE.md: 28,224 chars -> WORKSPACE.md (project-neutral)
  WORKSPACE.md: 117 chars -> WORKSPACE.md (project-neutral)
  REVIEW CLAUDE.md carries 28,224 chars of operator content and is scoped to claude-only by filename.
```

A `REVIEW` line is a decision, not an error: it flags a substantial body that
arrived from a provider-named file. The content now lands where every provider
reads it, so if part of it is genuinely provider-specific, move that part to
`.aiwg/context/providers/<name>.md` *after* applying — and know that nothing
auto-loads that directory, so it is reference material a session must be told
to read. `aiwg doctor` reports any such file as `provider-context-not-loaded`.
The same data is available as `plan.routing` and `plan.scopeReview` under
`--json`.

After applying, commit `WORKSPACE.md` and the provider bootstraps. Transaction preimages under
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
