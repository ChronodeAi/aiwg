# Upstream carried changes — Hermes provider

Commits on `hermes-adapter-0.21` that must survive every upstream merge
(`upstream` = jmagly/aiwg). After any `git merge upstream/main`, re-verify
each anchor; re-cherry-pick from this branch if a merge dropped one.

| Commit | Type | Anchor to verify (grep in tools/agents/providers/hermes.mjs or docs/) |
|---|---|---|
| feat(hermes): drop .hermes.md thin pointer… (`9cc22f3f1`) | behavior | `removeStaleAiwgHermesMd` exists; no `generateHermesMd` call site |
| fix(hermes): raise AGENTS.md cap to 38K… (`d0bde0903`) | behavior | `HERMES_AGENTS_MD_HARD_CAP = 38_000` |
| fix(hermes): correct subagent context-file claim… (`d37e6f5e7`) | behavior | `embed the workspace` present; `automatically exclude context files` absent |
| docs(hermes): refresh curator rationale… (`a5cea0592`) | docs | `is_curation_eligible` in updateBundledManifest docstring |

## Next upstream merge procedure

1. `git fetch upstream && git checkout -b merge-upstream-v<newtag> && git merge upstream/main`
2. If `tools/agents/providers/hermes.mjs` conflicts: keep BOTH upstream's
   non-Hermes-adapter changes AND our anchors above (our changes are
   Hermes-only; upstream rarely touches this file — last touch 12f09ce, 2026-08-20).
3. Re-verify anchors:

   ```bash
   grep -c "removeStaleAiwgHermesMd\|HERMES_AGENTS_MD_HARD_CAP = 38_000\|embed the workspace" tools/agents/providers/hermes.mjs
   # EXPECT: 3
   ```

4. Re-run: `npx vitest run --config config/vitest.config.js test/integration/hermes-deployment.test.ts test/unit/providers/hermes-agents-md-cap.test.ts`
5. Confirm the carried series is still ahead of upstream:

   ```bash
   git log --oneline upstream/main..HEAD -- tools/agents/providers/hermes.mjs
   ```

## Pre-existing test caveat (not ours)

`test/unit/sessions/hermes-adapter.test.ts` fails on this machine with
"session SQLite repository requires optional peer dependency better-sqlite3"
— environmental, fails identically at the pre-branch base `af91ab3f3`.
Install `better-sqlite3` to fix; do not chase it as an adapter regression.
