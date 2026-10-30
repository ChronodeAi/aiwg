# AIWG Corpus Navigation Guide

`@file` references in AIWG skills and agents are not citations or footnotes. They are **context injection directives** — the mechanism by which an agent loads additional knowledge as it works. Understanding this changes how you design skills.

## The Mental Model

When an agent reads a SKILL.md, it encounters `@file` references. Each one is an invitation: *open this to go deeper*. The agent decides which invitations to follow based on what the current task requires. A simple question might need only the top-level skill. A complex orchestration might follow every ref several levels deep.

This is lazy loading. Nothing loads until the agent chooses to follow the ref.

**Consequence for skill design**: a skill is not a document — it is a map. The map points to the territory. The territory lives in the corpus.

## Context Flows Through References

```
User trigger
    │
    └── SKILL.md (entry point — thin)
            │
            ├── @rule → behavioral constraint (loaded when enforcing that constraint)
            ├── @template → artifact structure (loaded when generating that artifact)
            ├── @agent → specialist persona (loaded when delegating that task)
            ├── @schema → validation spec (loaded when validating output)
            └── @.aiwg/AIWG.md → project context (loaded to understand this project)
```

The skill controls what context is *available*. The agent controls what it *loads*. Good skill design makes the right context available without forcing all of it in at once.

## The Thin Skill Principle

A well-designed skill is a thin entry point:

- **Minimal prose**: just enough framing to orient the agent
- **Refs to everything needed**: rules, templates, schemas, agents, project memory
- **No duplication**: if a rule already says it, link to the rule — do not restate it

Compare:

**Over-documented skill (bad)**:
```markdown
# Generate Tests

When generating tests, always write the test before the implementation.
Never delete existing tests to make new ones pass. Tests must be
deterministic. Coverage must not regress below the current baseline.
All edge cases must be explicitly tested...
[200 lines of rules restated from elsewhere]
```

**Thin skill with refs (good)**:
```markdown
# Generate Tests

Generates comprehensive test suites for the specified scope.

## References

- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/executable-feedback.md — Test execution requirements
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/anti-laziness.md — Never delete tests
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/testing/ — Test artifact templates
- @.aiwg/testing/ — Project-specific test strategy and existing coverage baseline
```

The second version is shorter, always up-to-date (rules update in one place), and gives the agent exactly what it needs to go as deep as required.

## Composite Skills

A composite skill references multiple corpus documents to cover an orchestration that spans concerns. It acts as a switchboard — the agent follows whichever refs are relevant to the current step.

```markdown
# Address Issues

Works through open issues using the issue thread as a shared collaboration surface.

## Composition

- @$AIWG_ROOT/.../skills/ralph/SKILL.md — Iterative loop engine
- @$AIWG_ROOT/.../skills/issue-list/SKILL.md — Fetch and filter issues
- @$AIWG_ROOT/.../skills/issue-comment/SKILL.md — Post cycle status to thread
- @$AIWG_ROOT/.../skills/issue-close/SKILL.md — Close resolved issues
- @$AIWG_ROOT/.../skills/issue-sync/SKILL.md — Link commits to issues
- @$AIWG_ROOT/.../rules/context-budget.md — Parallel subagent limits
```

Each ref is a door. The agent opens the doors it needs for the current step of the workflow. When posting a comment, it opens `issue-comment`. When closing, it opens `issue-close`. The skill itself contains no duplicated logic — it only points.

This is the preferred composition pattern throughout the AIWG corpus. Composite skills enable:

- **High reuse**: each corpus document is a single source of truth referenced by many skills
- **Agent choice**: the agent decides how deep to go based on task complexity
- **Easy maintenance**: change a rule once; every skill that links to it picks up the change
- **Context efficiency**: the agent loads only what the current step needs

## Reference Tiers in Practice

Different ref types serve different context roles:

| Ref type | When the agent loads it | Design intent |
|----------|------------------------|---------------|
| `@.aiwg/AIWG.md` | Always — project orientation | Orient to this specific project |
| `@.aiwg/requirements/` | When generating or validating against requirements | Inject project-specific requirements |
| `@$AIWG_ROOT/rules/X.md` | When the constraint governed by rule X is relevant | Enforce behavioral constraint |
| `@$AIWG_ROOT/templates/X/` | When generating artifact X | Provide structure for output |
| `@$AIWG_ROOT/agents/X.md` | When delegating task X to a specialist | Inject specialist persona |
| `@$AIWG_ROOT/schemas/X.yaml` | When validating output against schema X | Validate structure |
| `@$AIWG_ROOT/skills/X/SKILL.md` | When orchestrating a sub-workflow | Provide sub-workflow instructions |

## Ordering and Annotation

Order refs by likelihood of use — most frequently needed first. Annotate each ref with what it provides so the agent knows whether to follow it for the current task:

```markdown
## References

- @$AIWG_ROOT/.../rules/anti-laziness.md — Never skip tests, never remove features to make them pass
- @$AIWG_ROOT/.../rules/executable-feedback.md — Run tests and verify before marking complete
- @$AIWG_ROOT/.../templates/testing/ — Test artifact templates (load when generating test plan)
- @.aiwg/testing/ — Project test strategy and coverage baseline (load when scoping work)
- @.aiwg/AIWG.md — Project context: current phase, constraints (always load)
```

The annotation after ` — ` tells the agent *why* this ref exists, which helps it decide whether to follow it for the current step.

## Grouping Related Refs

For skills with many refs, group them by role to help the agent navigate:

```markdown
## References

### Behavioral constraints
- @$AIWG_ROOT/.../rules/anti-laziness.md
- @$AIWG_ROOT/.../rules/executable-feedback.md

### Artifact templates
- @$AIWG_ROOT/.../templates/testing/test-plan-template.md
- @$AIWG_ROOT/.../templates/testing/test-case-template.md

### Project context
- @.aiwg/AIWG.md
- @.aiwg/testing/

### Related skills
- @$AIWG_ROOT/.../skills/generate-tests/SKILL.md
- @$AIWG_ROOT/.../skills/security-gate/SKILL.md
```

## Anti-Patterns

**Restating rules inline**: if the content belongs in a rule, it belongs in a rule file. A skill that copies rule text is a skill that will drift out of sync.

**Over-linking**: every ref is a potential context load. Refs to docs that are never needed for this skill's actual use add noise. Link what is genuinely relevant.

**Circular refs**: skill A links to skill B which links back to skill A. Use the `no-circular-skill-calls` rule to detect these. See the aiwg-dev rules for detection.

**Deep nesting without landmarks**: if an agent following your refs must go 4+ levels deep before finding actionable content, restructure. Each level should deliver value — it should not just point to the next level.

**Mixing concerns**: a skill about generating requirements should not include refs to deployment templates. Keep the ref set scoped to the skill's actual concern.

## The No-Escape Rule

There is no backtick or code-block escape for `@` references. Every `@<path>` in a deployed skill is processed as a context-load directive regardless of surrounding markup — inline code, fenced code blocks, bullets. This is by design.

**Consequence**: when documenting bad patterns or showing legacy examples, drop the `@` prefix. Show the raw path without `@` so it is not processed as a directive.

```markdown
Bad example (will be processed as a directive):
  agentic/code/frameworks/sdlc-complete/rules/foo.md  ← no @ prefix in examples

Not:
  @agentic/code/frameworks/sdlc-complete/rules/foo.md  ← this WILL be loaded
```

## Validation

Run link-check to verify all refs in a skill resolve correctly:

```
/link-check agentic/code/frameworks/sdlc-complete/skills/my-skill/SKILL.md
```

Or corpus-wide:

```
/link-check agentic/code/
```

See `dev-doctor` Section 4 for the same checks as part of the full repo health check.

## Related

- `docs/development/aiwg-dir-reference-contract.md` — What ref patterns are valid (PASS/WARN/FAIL classification)
- `docs/development/skill-creation-guide.md` — Skill anatomy and creation workflow
- `agentic/code/addons/aiwg-dev/skills/link-check/SKILL.md` — Automated ref validation
- `agentic/code/addons/aiwg-dev/rules/aiwg-dir-reference-contract.md` — Enforcement rule
- `agentic/code/addons/aiwg-dev/rules/addon-boundaries.md` — Source vs project output boundary
