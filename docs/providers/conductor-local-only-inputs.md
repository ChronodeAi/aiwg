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
without reading protected contents. Unrelated calls proceed; malformed hook events
are refused. Operator permissions and hooks are preserved.

Codex deployment writes `.codex/rules/aiwg-local-only.rules` with forbidden
`prefix_rule` entries for explicit `cat`, `head`, `tail`, `less`, `more`, `sed`,
`awk`, `grep` and `rg` commands whose first argument is a declared relative,
`./`-relative or absolute path. These require a Codex version/session that loads
trusted project rules. They do not restrict native file-reading tools. Options
before the path, descendant arguments and shell wrappers are outside these exact
prefix rules; do not treat their presence as filesystem containment.

These guards prevent the reported explicit reads, with stronger coverage in
Claude than Codex. They are not an OS read sandbox: glob expansion, variable-built
paths, recursive searches of an ancestor directory, hardlink aliases, encoded
programs, unrecognized tools, disabled hooks/rules, policy tampering and filesystem
races can bypass them. Even Claude's shell hook can conservatively refuse a benign
command that merely mentions a protected path. Keep sensitive data outside the
cloud conductor's accessible filesystem when comprehensive containment is needed.
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
