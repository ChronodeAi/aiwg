# Muse Code path security review (#231)

**Date:** 2026-10-02 (America/New_York)  
**Scope:** Path resolution, deploy writers, hooks/MCP merges, session discovery, and native config inspection for
provider `muse`  
**Sources reviewed:** `src/providers/muse-paths.ts`, `tools/agents/providers/muse-paths.mjs`,
`src/cli/scope-resolver.ts` (`USER_SCOPE_PATHS.muse`), `tools/agents/providers/muse.mjs`,
`tools/agents/providers/muse-hooks.mjs`, `src/skills/deployer.ts` (muse branch),
`src/sessions/adapters/muse.ts`, `src/mcp/muse-native-config.mjs`

## Threats considered

| Threat | Result |
| --- | --- |
| Invented Muse home layout | Mitigated in `src/providers/muse-paths.ts`: only project or XDG skill roots. |
| Bad XDG metadata | `src/providers/muse-paths.ts` rejects relative paths, bare `~`, NUL, and `/`. |
| User-scope deploy into a guessed path | `src/cli/scope-resolver.ts` returns no skill lane on bad metadata. |
| Default deploy duplicates Muse user skills | `src/skills/deployer.ts` writes the user root only with `--scope user`. |
| Deploy into `.cursor/**` | Mitigated in `tools/agents/providers/muse.mjs`: `assertNotCursorTarget()` refuses it. |
| AGENTS.md symlink overwrite | `tools/agents/providers/muse.mjs` refuses symlink or non-file targets. |
| Operator skill deletion | Mitigated in `tools/agents/providers/muse.mjs`: managed markers bound stale-prune cleanup. |
| Unmanaged hook install | `tools/agents/providers/muse-hooks.mjs` manages only sidecar-tracked groups. |
| Destructive hook rewrite | `muse-hooks.mjs` preserves operator groups and backs up hand-edited files. |
| JSONC parse corrupting strings on rewrite | `muse-hooks.mjs` strips comments with a string-aware scanner, so URLs and glob matchers survive. |
| Symlinked `.muse` escape | Mitigated in `muse-hooks.mjs`: `assertMuseDirNotSymlink()` refuses hook writes. |
| Malformed hook JSON clobber | Mitigated in `muse-hooks.mjs`: invalid JSON/shape aborts the merge with zero writes. |
| MCP settings clobber | Mitigated in `muse-hooks.mjs`: `--mcp` is opt-in and backups precede writes. |
| Operator-owned `mcp_servers.aiwg` replacement | `muse-hooks.mjs` skips untracked noncanonical `aiwg` keys. |
| Muse session home scraping | `src/sessions/adapters/muse.ts` has no default root; `--muse-root` is explicit. |
| Native session broad crawl | Mitigated in `muse.ts`: bounded walk of `$root/YYYY/MM/DD/<id>/session.jsonl` only. |
| Native session symlink following | Mitigated in `muse.ts`: discovery accepts only `Dirent` directory/file entries. |
| Export ingestion schema drift | Mitigated in `muse.ts`: Zod validation plus export schema major `1` gate. |
| Native config secret scrape | `src/mcp/muse-native-config.mjs` never reads `auth.json`. |
| Credential or model-output leakage | Mitigated in `muse-native-config.mjs`: reports state only, not settings bodies. |

## Absolute-root policy observed

1. **Project default** -> `<repo>/.agents/skills`, with standard-tier mirror only under
   `<repo>/.agents/.aiwg/skills` when `--copy-all` is explicit.
2. **Unset `XDG_CONFIG_HOME`** -> documented default `~/.config/muse/skills`.
3. **Absolute `XDG_CONFIG_HOME`** -> `<xdg>/muse/skills`.
4. **Leading `~/...`** -> expanded against the operator home, then validated as absolute.
5. **Relative, bare `~`, NUL, or `/`** -> rejected or skipped fail-closed with remediation.
6. **Session discovery** -> no default root; only explicitly authorized roots are searched.

## Residual / out of scope

- Hooks run as shell commands outside Muse's sandbox once an operator trusts the workspace. AIWG installs only a
  read-only drift check, but the risk is inherent to Muse project hooks and should remain visible in docs.
- Muse Code also loads foreign personal skills from `~/.claude/skills` and `~/.codex/skills`. AIWG avoids writing
  extra Muse copies by default, but operators with user-scope Claude/Codex deploys can still see those skills in Muse.
- The optional Ralph `muse exec` adapter remains separate from provider stability; live runs still require an
  authenticated Muse CLI and the adapter's own evidence gates.
- Linux-only evidence was accepted for #231. macOS and Windows PUW were waived by maintainers on 2026-10-02, so those
  platform path semantics remain unevidenced in this promotion.

## Conclusion

The reviewed Muse Code provider paths match the ADR's fail-closed ownership boundary. Project deploys use
`.agents/skills` and `AGENTS.md`; user-scope writes use the documented XDG Muse skills root; hooks and MCP merges are
sidecar-tracked and additive; session discovery requires explicit authorization; and native config inspection is
read-only. No path-traversal, provider-confusion, or secret-scrape defect was found in the reviewed surfaces. Stable
promotion is approved for #231 under the maintainer Linux-only waiver dated 2026-10-02.
