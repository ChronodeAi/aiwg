---
name: skill-discovery-guidance
description: Supporting rationale and examples for skill-discovery
enforcement: low
activation: on-demand
---

# skill-discovery — guidance

Authority: `aiwg show rule skill-discovery` (kernel). This companion supplies supporting explanation; the complete imperative core is self-contained in that rule.

## Overview

AIWG ships hundreds of skills/agents/commands/rules, but platforms cap how many they list. AIWG deploys two tiers: **kernel skills** (always loaded — ~10 quickrefs + core utilities) and **standard skills** (at `<provider-dir>/.aiwg/skills/`, *not* listed; reachable only through the artifact index). **Most AIWG skills are not in your context.** The discipline: **query the index before declining or improvising.**

## Examples

### Rule 5: Discover → Show Is the Canonical Access Pattern

```bash
aiwg discover "deploy to production"        # ranked candidates with paths
aiwg show skill flow-deploy-to-production   # streams the SKILL.md body
```

## Query Patterns

```bash
aiwg discover "audit the supply chain"        # by capability
aiwg discover "validate" --type skill         # by type filter
aiwg discover "..." --json --limit 3          # token-tight; stable schema for sub-agents
```

## Interaction with Other Rules

- **research-before-decision** — for AIWG-internal content, "research" means `aiwg discover` + `aiwg show`, NOT filesystem `Read`/`Glob`/`Grep`.
- **instruction-comprehension** — pass the *parsed* intent to discover, not ambiguous verbatim words.
- **human-authorization** — never invoke a destructive skill without authorization, even on a discover match.
- **god-session** — discover is one focused step; decompose complex multi-skill flows rather than absorbing them.

Universal across all AIWG providers — the `discover` subcommand works against the artifact index regardless of which provider deployed the skills.
