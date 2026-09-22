# Rule Creation Guide

Rules encode what an agent must or must not do. They are indexed and discoverable
the same way skills are — but unlike a skill, a rule is rarely invoked by name. An
agent reaches a rule by asking a question ("am I allowed to delete this?"), so a
rule that declares no trigger phrases is effectively unreachable by the discovery
protocol that is supposed to surface it.

## Rules support `triggers`

`rule` is in `OPERATIONAL_DISCOVERY_TYPES`, so the indexer runs the same trigger
extraction over rule bodies that it runs over skills (`src/artifacts/index-builder.ts`).
Declare triggers in frontmatter:

```markdown
---
enforcement: high
triggers:
  - "am I allowed to do this"
  - "do I need permission for this"
  - "can I delete this"
---

# Human Authorization Rules
```

A `## Triggers` section works too (also `## Natural Language Triggers`,
`## Activation Phrases`, `## When to invoke`), but frontmatter is preferred for
rules: it keeps the rendered body focused on the rule itself.

## Why this matters more for rules than for skills

Discovery ranking weights trigger matches heavily. A skill usually also has a
distinctive name an agent might guess (`flow-deploy-to-production`); a rule's name
describes the *policy*, not the *question* — nobody queries "delivery-policy", they
query "should I open a pull request". Without triggers a rule only ranks on lexical
overlap with its title and summary, and loses to any skill whose triggers happen to
cover a token.

Measured before and after adding triggers to `respect-repo-access-manifest`:

```
before: aiwg discover "register a repo in the workspace manifest"
  1. Status (aiwg-status)  skill  1.00      <- wrong answer
  (the rule does not appear)

after:
  1. Respect Repo Access Manifest  rule  1.00
     ranking: trigger covers 100% of query tokens
```

No indexer change was needed. The capability existed; the rule had not declared any.

## Writing triggers an agent will actually type

Write the **question the agent is asking**, not the rule's subject.

| Instead of | Write |
|---|---|
| `"human authorization"` | `"am I allowed to do this"`, `"do I need permission for this"` |
| `"token security"` | `"where do I put an api key"`, `"load a secret in a script"` |
| `"anti-laziness"` | `"can I skip this test"`, `"should I delete this test"` |
| `"delivery policy"` | `"should I open a pull request"`, `"can I commit to main"` |

Guidance:

- **3–6 phrases** is usually enough. More dilutes rather than helps.
- **Phrase them as an agent mid-task would**, first person, in the moment of doubt.
- **Avoid single generic words.** A one-word trigger like `persona` matches far too
  much; the scorer already downweights some of these specifically.
- **Do not restate the title.** Title and summary are already indexed.

## Checking coverage

```bash
npm run lint:rule-triggers          # report rules with no trigger phrases
npm run lint:rule-triggers -- --json
```

The lint reports rather than fails, so coverage can close incrementally. Run it
after adding a rule, and verify the rule is actually reachable:

```bash
aiwg index build --graph framework --force    # at the install root
aiwg index sync --backend fortemi-core --graph framework
aiwg discover "<the question your rule answers>"
```

The build step only works at the install root — the framework graph indexes the
AIWG corpus, which does not exist in a consumer project.

## Related

- [`skill-creation-guide.md`](skill-creation-guide.md) — the same trigger mechanism for skills
- [`../addons/aiwg-utils/rules-reference.md`](../addons/aiwg-utils/rules-reference.md) — what the shipped rules enforce
