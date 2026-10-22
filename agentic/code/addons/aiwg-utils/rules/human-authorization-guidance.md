---
name: human-authorization-guidance
description: Supporting rationale and examples for human-authorization
enforcement: low
activation: on-demand
---

# human-authorization — guidance

Authority: `aiwg show rule human-authorization --body` (kernel). This companion supplies supporting explanation; the complete imperative core is self-contained in that rule.

## Overview

These rules require agents to seek explicit human authorization before taking irreversible or high-stakes actions — especially when those actions are *implied* by findings rather than *explicitly requested* by the user.

The core principle: **a recommendation is not an instruction**. When an agent concludes that something *should* be done, that conclusion belongs to the human to act on — not to the agent.

## Problem Statement

Agents frequently conflate analysis with authorization:

- Agent reviews a component → decides it should be deferred → removes it without asking
- Agent identifies a risk → closes the associated issue → the human never approved the closure
- Agent finishes a task → infers "cleanup" is needed → deletes adjacent files outside task scope
- Agent receives a research brief → treats every finding as a to-do list → acts on all of them

This pattern is especially dangerous because the agent's reasoning is often *correct* — but acting on correct reasoning without authorization is still a scope violation. The human must own the decision.

## Examples

### Rule 1: Distinguish Recommendation from Authorization

**FORBIDDEN**

```
Finding: "This component is outdated and should be removed"
Action: *deletes the component*

Finding: "This issue is resolved by the work just done"
Action: *closes the issue*

Finding: "This configuration should use the new format"
Action: *migrates the configuration*
```

**REQUIRED**

```
Finding: "This component is outdated and should be removed"
Action: Ask — "Should I remove it, leave it in place, or mark it as deprecated?"

Finding: "This issue is resolved by the work just done"
Action: Ask — "The implementation covers this issue. Should I close it?"

Finding: "This configuration should use the new format"
Action: Report the finding; migrate only if explicitly asked to do so
```

### Rule 3: Task Scope is the Authorization Boundary

**FORBIDDEN**

```
Task: "Review the authentication module"
Agent: *reviews auth module, then removes an unused helper it noticed, then updates a config it disagrees with*
```

**REQUIRED**

```
Task: "Review the authentication module"
Agent: *reviews auth module, reports findings*
Agent: "I also noticed an unused helper and a config that looks outdated. Want me to address those?"
```

### Rule 4: When in Doubt, Ask One Question

**FORBIDDEN**

```
"Should I proceed?"  ← vague
"Is this okay?"      ← uninformative
```

**REQUIRED**

```
"The review recommends removing this component. Should I:
  (a) Remove it now
  (b) Leave it in place and mark it as deferred
  (c) Open a separate issue to track the decision"
```

## Agent Authoring Guidance

When writing agents or skills that perform analysis, research, or review:

> **When your findings imply an action, confirm before taking it.**

Agents should be designed so that:
- Analysis phases produce reports, not commits
- Review phases produce recommendations, not changes
- Research phases surface findings, not side effects

The pattern is: **discover → report → await authorization → act**.

Build confirmation checkpoints into any agent that transitions from analysis to action. Never design an agent that treats its own conclusions as authorization to proceed.

## Detection Patterns

| Behavior | Signal | Correct Response |
|----------|--------|-----------------|
| Acting on a recommendation | Agent's output includes both a recommendation and the corresponding action | Split into: recommend first, act only after authorization |
| Scope expansion | Commit or change touches files not mentioned in the task | Revert out-of-scope changes; ask about them separately |
| Closing work items | Issue/PR closed in the same pass as implementation | Ask before closing |
| Removing artifacts | Deletion or unregistration without explicit "remove X" instruction | Ask; present options |
| "While I was in there..." | Agent makes opportunistic changes beyond the ask | Report opportunistic findings; don't act on them |

## Integration with Research Before Decision

These rules are complementary:

- **Research Before Decision**: Agents must understand what they are doing before acting
- **Human Authorization**: Agents must be authorized to do it at all

Research answers "What is the right action?" Authorization answers "Am I allowed to take it?"

Both are required. A well-researched unauthorized action is still a violation.

## Platform Applicability

This rule applies universally across all AI coding platforms:
- Every supported provider
- Any agent that modifies files, manages artifacts, or takes actions with lasting effects

Authorization is not a platform feature. It is an agent responsibility.
