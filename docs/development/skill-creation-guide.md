# Skill Creation Guide

Skills are reusable, auto-triggering capabilities that extend agent functionality. Unlike commands (user-invoked) or agents (orchestrator-launched), skills activate automatically when context matches.

## Skill Anatomy

```
skills/
└── my-skill/
    ├── SKILL.md          # Required: Skill definition
    └── scripts/          # Optional: Implementation scripts
        └── my_script.py
```

### SKILL.md Structure

**REQUIRED frontmatter fields:** `name` and `description` (non-empty).
Codex rejects any SKILL.md without a non-empty `description:` field, and
Claude Code uses it as the primary natural-language invocation signal.
Tooling (scaffolder, SkillSmith generator, platform deployers) enforces
this at runtime.

```markdown
---
name: my-skill
description: Brief description (REQUIRED, non-empty — shown in skill catalog and used for NL matching)
triggers:
  - pattern: "regex or keyword"
    weight: 0.8
tags: [category, domain]
---

# Skill Title

## Purpose

What this skill does and when it activates.

## Execution Steps

1. Step one
2. Step two

## Output Format

Expected output structure.
```

## Trigger Patterns

Skills activate based on trigger patterns matching user context:

| Trigger Type | Example | Use Case |
|--------------|---------|----------|
| Keyword | `"security review"` | Direct phrase match |
| Regex | `"(deploy|release) to prod"` | Flexible matching |
| Context | `"*.test.ts"` file in context | File-based activation |

## Implementation Patterns

### Prompt-Only Skills

Most skills need no code - the SKILL.md prompt is sufficient:

```markdown
## Execution Steps

1. Read the target file using the Read tool
2. Analyze for patterns X, Y, Z
3. Report findings in structured format
```

### Script-Backed Skills

For complex logic, add Python/Node scripts:

```markdown
## Execution Steps

1. Run `scripts/analyze.py` with file path
2. Parse JSON output
3. Present findings to user
```

Script conventions:
- Location: `skills/<skill-name>/scripts/`
- Input: CLI arguments or stdin
- Output: JSON to stdout
- Errors: stderr with exit code

## Creating a Skill

### Via CLI

```bash
aiwg add-skill my-skill --to aiwg-utils
```

### Via DevKit Command

```
/devkit-create-skill my-skill
```

### Manual Creation

1. Create `skills/my-skill/SKILL.md`
2. Add frontmatter with name, description, triggers
3. Document execution steps
4. Optionally add scripts

## Skill Categories

| Category | Location | Purpose |
|----------|----------|---------|
| SDLC | `sdlc-complete/skills/` | Lifecycle workflows |
| Marketing | `media-marketing-kit/skills/` | Campaign operations |
| Utilities | `aiwg-utils/skills/` | Cross-cutting tools |
| Voice | `voice-framework/skills/` | Writing assistance |
| Testing | `testing-quality/skills/` | Test automation |
| Doc Intel | `doc-intelligence/skills/` | Document processing |

## Skill vs Command vs Agent

| Aspect | Skill | Command | Agent |
|--------|-------|---------|-------|
| Invocation | Auto-trigger | `/slash-command` | Task tool |
| Scope | Single capability | User workflow | Domain expertise |
| Context | Stateless | Session | Isolated |
| Output | Inline | Varies | Report back |

## Best Practices

1. **Single responsibility**: One skill, one purpose
2. **Clear triggers**: Avoid overlapping patterns
3. **Graceful degradation**: Handle missing context
4. **Structured output**: Consistent format
5. **Documentation**: Explain when/why skill activates

## Testing Skills

```bash
# Validate skill structure
node tools/scaffolding/validate.mjs skills/<skill-name>

# Test trigger matching
aiwg skill-test <skill-name> "sample context"
```

## Deployment

Skills deploy automatically with `aiwg use`:

```bash
aiwg use sdlc        # Deploys SDLC skills to .claude/skills/
aiwg use marketing   # Deploys marketing skills
aiwg use all         # Deploys all skills
```

## Reference Design

The References section of a SKILL.md is not a bibliography — it is the primary mechanism for injecting context into the agent. An agent follows `@` refs to load rules, templates, schemas, and related skills as needed. **The skill is the map; the corpus is the territory.**

### Thin skills with refs (preferred)

Avoid restating content that already exists in rules or other skills. Link instead:

```markdown
## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/anti-laziness.md — Never skip tests
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/executable-feedback.md — Run and verify before completing
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/testing/ — Test artifact templates
- @.aiwg/testing/ — Project test strategy and coverage baseline
```

### Composite skills

A composite skill references multiple corpus documents to cover an orchestration that spans concerns. The skill contains minimal prose — it points to the docs that contain the detail:

```markdown
# Issue Workflow Orchestrator

Coordinates issue listing, commenting, and closure.

## References

- @$AIWG_ROOT/.../skills/issue-list/SKILL.md — Fetch and filter issues
- @$AIWG_ROOT/.../skills/issue-comment/SKILL.md — Post structured status comments
- @$AIWG_ROOT/.../skills/issue-close/SKILL.md — Close resolved issues
- @$AIWG_ROOT/.../rules/context-budget.md — Parallel subagent limits
```

The agent opens whichever refs are relevant to the current step. Nothing loads until the agent follows a ref.

See `docs/development/corpus-navigation-guide.md` for the full context architecture and design patterns.

## References

- [Corpus Navigation Guide](corpus-navigation-guide.md) — How refs guide agent context; composite skill pattern
- [Reference Contract](aiwg-dir-reference-contract.md) — What ref patterns are valid
- [DevKit Overview](devkit-overview.md)
- [Add-Skill CLI](https://github.com/jmagly/aiwg/blob/main/tools/scaffolding/add-skill.mjs)
- [Skill Factory Addon](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/skill-factory/)
