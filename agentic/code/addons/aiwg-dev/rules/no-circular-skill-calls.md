# No Circular Skill Calls

**Enforcement Level**: HIGH
**Scope**: aiwg-development
**Addon**: aiwg-dev (devOnly)

## Overview

A legacy CLI command bridge marked `executedViaSkillRunner: true` MUST NOT have a SKILL.md whose execution path calls back into `aiwg <same-command>`. This creates an infinite loop with no exit condition. This rule governs CLI bridge internals only; new workflow authoring should still treat `SKILL.md` as the canonical surface.

## Problem Statement

AIWG's skill runner executes legacy command bridges by reading the associated SKILL.md and running the instructions using provider tools (Read, Write, Bash, Task, or provider equivalents). When a command is marked `executedViaSkillRunner: true`, its TypeScript handler is removed from the CLI routing table — the CLI defers entirely to the SKILL.md.

If that SKILL.md then invokes the CLI command (e.g. says "run `aiwg doctor`"), the system enters a loop:

```
User invokes: aiwg doctor
  ↓
CLI: no handler (executedViaSkillRunner: true), delegates to skill runner
  ↓
Skill runner reads SKILL.md
  ↓
SKILL.md says: "run `aiwg doctor`"
  ↓
CLI: no handler (executedViaSkillRunner: true), delegates to skill runner
  ↓
  [infinite loop — never terminates]
```

This is a silent failure mode: the loop may appear to run for several iterations before timing out, consuming tokens with no output.

## Mandatory Rules

### Rule 1: Self-Contained SKILL.md When Using `executedViaSkillRunner: true`

If a legacy command bridge has `executedViaSkillRunner: true` in its definition, its SKILL.md MUST perform all work using provider tools directly — it MUST NOT invoke the CLI command by name.

**FORBIDDEN** (when `executedViaSkillRunner: true`):
```markdown
## Behavior

Run the following to check your installation:

```bash
aiwg doctor
```
```

**REQUIRED** (when `executedViaSkillRunner: true`):
```markdown
## Behavior

1. Read `.aiwg/frameworks/registry.json` using the Read tool
2. Verify the registry is valid JSON
3. Check that the active provider deployment contains expected agent files
4. Read Node.js version: `node --version`
5. Report pass/fail for each check
```

### Rule 2: Legacy Command Bridges With TypeScript Handlers May Reference CLI Commands

If a legacy command bridge retains its TypeScript handler (i.e. does NOT set `executedViaSkillRunner: true`), its SKILL.md may reference the CLI command — the handler will receive the invocation and execute the logic.

This is the correct pattern when:
- The command does substantial work in TypeScript (file I/O, npm calls, complex logic)
- The SKILL.md is supplementary documentation rather than the execution path
- The command needs to run reliably in non-skill-runner environments

### Rule 3: Audit Before Setting `executedViaSkillRunner: true`

Before adding `executedViaSkillRunner: true` to any command definition, perform this check:

1. Open the command's SKILL.md
2. Search for `aiwg <command-name>` in any bash block or instruction
3. If found: the SKILL.md must be rewritten to use provider tools directly before the flag is set

## Reference Implementation

`sdlc-accelerate` is the canonical example of a correct `executedViaSkillRunner: true` legacy command bridge. Its SKILL.md orchestrates entirely through provider tools with no CLI callback. Use it as a style reference when maintaining skill-executed command bridges.

**Location**: `agentic/code/addons/aiwg-utils/skills/` (check the sdlc-accelerate skill directory)

## Detection Patterns

| Symptom | Likely Cause |
|---------|-------------|
| Command hangs or produces no output | Possible circular loop |
| Skill runner starts but appears stuck | SKILL.md invoked CLI, loop entered |
| Token usage spikes with no result | Loop ran multiple times before timeout |
| `executedViaSkillRunner: true` in definition AND `aiwg <name>` in SKILL.md | Direct violation |

## Safe Pattern Reference

```
Legacy command bridge: my-command
  executedViaSkillRunner: true
  ↓
SKILL.md — must do all work with:
  - Read tool (read files)
  - Write tool (write files)
  - Bash tool or provider shell equivalent (run shell commands)
  - Task tool or provider delegation equivalent (delegate to subagents)
  - Direct script invocation: node tools/cli/my-script.mjs

MUST NOT contain:
  - aiwg my-command
  - aiwg <any command that itself delegates back to my-command>
```

## References

- @$AIWG_ROOT/src/extensions/commands/definitions.ts — Legacy command bridge definitions with `executedViaSkillRunner` field
- @$AIWG_ROOT/src/cli/handlers/ — TypeScript handlers (absent when `executedViaSkillRunner: true`)
- @$AIWG_ROOT/agentic/code/addons/aiwg-dev/rules/component-completeness.md — Legacy command bridge completeness requirements

---

**Rule Status**: ACTIVE
**Last Updated**: 2026-4-1
