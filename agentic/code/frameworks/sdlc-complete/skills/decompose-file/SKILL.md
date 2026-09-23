---
namespace: aiwg
name: decompose-file
platforms: [all]
description: Plan and execute a source-file split along one stated responsibility, with sibling-cycle and ratchet verification after the split
triggers:
  - "this file is too large"
  - "split into modules"
  - "decompose this file"
  - "split this file along a responsibility"
script:
  entrypoint: scripts/plan.mjs
  runtime: node
  cwd: project-root
  argsHint: "<file> --responsibility \"<one sentence>\" [--dry-run] [--execute]"
---

# decompose-file

Plan a source-file split along one stated responsibility, optionally execute it with import updates, and verify it with the code-shape ratchet.

## Purpose

Candidates come from `codebase-health`: files the ratchet flags (`function-worsened`, `file-growth`) or hotspots from `--history`. Size alone is not a reason to split. A split is justified only by a responsibility — the file's reason to change, stated in one sentence.

The doc-splitter skill handles documentation. This skill handles source code: dependency analysis, import rewiring and test verification.

## Required input: `--responsibility`

`--responsibility "<one sentence>"` names the reason to change that the extracted module will own. Refuse to plan or execute without it. The script exits 2 when it is missing.

```bash
aiwg run skill decompose-file -- src/extensions/registry.ts --responsibility "Validate extension manifests before registration"
```

The script prints the file's function table (`codebase-health --functions <file> --format json`: name, lines, NLOC, CCN) as the starting map.

## Mirage test

A split is wrong when either holds:

- it adds imports between the new siblings (the parts still depend on each other), or
- the parts co-change in nearly every commit — check the pairs from `aiwg run skill codebase-health -- --history`.

Moving code between files without separating a reason to change is a split mirage: the function count rises and total complexity does not fall (`split-mirage-candidate` in the ratchet).

## Behavior

1. **Analyze**: read the function table; group functions by the stated responsibility vs. the rest; identify shared state and exports with their consumers.
2. **Map dependencies**: trace references between the groups; detect cycles; list every import of the original file.
3. **Propose split**: one new module owning the stated responsibility (descriptive name, no `utils/helpers/common`); the rest stays. Each output file starts with a one-line purpose statement — for the new module, the responsibility sentence.
4. **Show dependency graph**: import direction between the original and the new module; no cross-sibling cycles.
5. **Execute** (with `--execute` or user approval): create the module, update imports across the codebase (re-export from the original only when external consumers require it), run tests.
6. **Verify**:
   ```bash
   aiwg run skill codebase-health -- --base HEAD~1 --architecture --ci
   ```
   Moved functions pair with their origin, so an honest move passes. A FAIL means the split worsened a function or increased above-band functions; a `split-mirage-candidate` WARN means the mirage test above failed.

## Decomposition Plan Format

```
Decomposition Plan for src/extensions/registry.ts
Responsibility: Validate extension manifests before registration

Function table (from codebase-health --functions):
  register        87-145   nloc=48 ccn=9
  validateManifest 392-440 nloc=41 ccn=12
  checkDependencies 442-480 nloc=33 ccn=7
  ...

Proposed Split:
  1. src/extensions/extension-validator.ts
     — purpose: Validate extension manifests before registration
     — validateExtension(), validateManifest(), checkDependencies()
     — imports from: none
  2. src/extensions/registry.ts (remainder)
     — imports from: extension-validator

Dependency Graph:
  registry → extension-validator
Cross-sibling cycles: NONE
Co-change (--history): registry.ts <-> extension-validator.ts not a pair
```

## Arguments

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `<file-path>` | Yes | — | File to decompose |
| `--responsibility "<sentence>"` | Yes | — | Reason to change the extracted module owns |
| `--dry-run` | No | true | Show plan without executing |
| `--execute` | No | false | Execute the plan |
| `--preserve-exports` | No | true | Keep re-exports for external consumers |

## Error Handling

- **No responsibility**: stop; ask for the one-sentence reason to change. Do not infer one from file size.
- **Circular dependency in the proposal**: the grouping is wrong; regroup along the responsibility rather than adding a shared `common` module.
- **Tests fail after split**: fix import paths, re-run tests, then re-run the ratchet.

## Integration

- `code-shape` rule: file-growth justification and conventions (purpose line, specific names)
- `codebase-health` skill: candidates, function table, history pairs, post-split ratchet
- `executable-feedback` rule: run tests after execution
- `anti-laziness` rule: do not skip the split because it is complex

## Output Locations

- Decomposition plan: `.aiwg/working/decompose-{filename}-{date}.md`
- New source files: same directory as the original (or user-specified)

## References

- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/code-shape.md — Code-shape policy
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/executable-feedback.md — Test after changes
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/codebase-health/SKILL.md — Candidates and verification
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/code-chunker/SKILL.md — Navigate large files before splitting
