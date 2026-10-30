# Protect local-only conductor inputs

Declare literal project-relative files or directory subtrees in the existing
`models.json` worker data policy before starting a cloud conductor:

```json
{
  "defaults": {
    "workerSelection": {
      "dataClasses": {
        "local-only": {
          "allowedProcessing": ["local"],
          "localOnlyPaths": ["eval-work/local.txt", "private-inputs"]
        }
      }
    }
  }
}
```

`dataPolicy.localOnlyPaths` also works without a named data class. Parallelism
groups and group templates accept the same field in their existing `dataPolicy`.
Paths are literal, slash-separated, project-relative names using letters, digits,
`_ . @ + , -`. Absolute paths, globs, spaces and `.`/`..` components are rejected.
Files and all descendants of declared directory paths are protected.

Deploy the project's Claude or Codex provider with the normal `aiwg use` workflow
**before opening task inputs**, then inspect worker readiness in `aiwg doctor`.
Deployment collects the union of base, named-class, group and template paths,
including inherited model policy. An empty project list cannot remove inherited
paths. All declarations apply regardless of the current task's selected class;
the deployer does not guess a conductor's processing locality from its model name.
Local workers that need these inputs must use separately configured local contexts.
Changes require redeployment and a provider session that loads the new settings.
Existing Claude denies are retained conservatively; removing all declarations
retains previously deployed guards until an operator removes them explicitly.

Claude deployment merges absolute `Read(...)` deny rules into
`.claude/settings.json` and installs a project-local PreToolUse hook. The hook
refuses explicit file/path tool arguments and literal Bash references, including
compound commands such as `ls && cat eval-work/local.txt | head`. It resolves
relative paths against the tool event's cwd and checks existing symlink aliases
without reading protected contents. It also matches unquoted Bash glob components
(`*`, `?`, `[...]` and `**`) against protected path names and subtrees, including
loops such as `for f in eval-work/*.txt; do cat "$f"; done`. Common recursive
ancestor searches (`grep -r`, `rg` and `find`, including `find ... -exec cat`)
are refused, with the event cwd used for implicit search roots. A plain
`ls eval-work`, an unrelated literal file and a glob such as `eval-work/*.json`
that cannot match a protected `eval-work/local.txt` remain allowed. Quoted or
escaped wildcard characters are literal. Operator permissions and hooks are
preserved; malformed hook events are refused.

Codex deployment writes `.codex/rules/aiwg-local-only.rules` with forbidden
`prefix_rule` entries for explicit `cat`, `head`, `tail`, `less`, `more`, `sed`,
`awk`, `grep` and `rg` commands whose first argument is a declared relative,
`./`-relative or absolute path. These require a Codex version/session that loads
trusted project rules. They do not restrict native file-reading tools. Options
before the path, descendant arguments and shell wrappers are outside these exact
prefix rules; do not treat their presence as filesystem containment.

These guards prevent the reported explicit reads, with glob and common recursive
search coverage in Claude only. They are not an OS read sandbox: variable-built
paths, other shell indirection (including brace expansion and command substitution),
wildcard symlink aliases, hardlink aliases, encoded programs, unrecognized recursive
readers or tools, disabled hooks/rules, policy tampering and filesystem races can
bypass them. The hook checks names and filesystem metadata, never protected file
contents, and does not interpret a full shell program or changes of directory
within it. Even Claude's hook can conservatively refuse a benign command that
merely mentions a protected path or searches an ancestor with exclusion filters.
Keep sensitive data outside the cloud conductor's accessible filesystem when
comprehensive containment is needed.
A task label or `allowedProcessing: ["local"]` alone cannot identify filesystem
paths; declare those paths before exploration instead of opening files to classify
them.

Existing implementation owners:

- `src/models/worker-selection-policy.ts`: validates data policy/classes and merges
  inherited restrictions; `src/models/provider-policy.ts` applies class restrictions
  to worker processing facts during selection, after conductor exploration.
- `src/config/worker-parallelism.ts`: existing per-group data policy;
  `src/config/worker-group-templates.ts`: inheritance and group narrowing.
- `tools/agents/providers/claude-post-deploy.mjs`: existing settings/context owner,
  extracted from `claude.mjs`; `src/mcp/tool-filters.mjs`: existing Claude deny merges.
- `tools/agents/providers/codex.mjs`: conventional project rules deployment;
  `conductor-data-guard.mjs`: compiles the new explicit command-prefix restrictions.
