---
name: instruction-comprehension-guidance
description: Supporting rationale and examples for instruction-comprehension
enforcement: low
activation: on-demand
---

# instruction-comprehension — guidance

Authority: `aiwg show rule instruction-comprehension --body` (kernel). This companion supplies supporting explanation; the complete imperative core is self-contained in that rule.

## Overview

These rules mandate that agents fully parse, understand, and follow user instructions before acting. The second most common complaint about AI coding assistants is that users have to paste the same instructions 5-6 times before the agent complies.

## Problem Statement

Agents frequently ignore or partially follow instructions:
- User says "use library X" — agent uses library Y
- User specifies exact format — agent uses a different format
- User lists 5 requirements — agent addresses 3 of them
- User says "don't change file Z" — agent changes file Z
- User corrects the agent — agent makes the same mistake again
- User provides context — agent ignores it and follows its own assumptions

This is not a capability limitation. It is a failure to read.

## Examples

### Rule 1: Parse All Instructions Before Acting

**FORBIDDEN**

```
User provides 5-paragraph request with specific constraints.
Agent reads the first sentence and starts coding.
```

**REQUIRED**

```
User provides 5-paragraph request with specific constraints.
Agent extracts:
  - Primary goal: [what]
  - Constraints: [don't change X, use library Y, follow pattern Z]
  - Specific requirements: [list of 5 items]
  - Format/style preferences: [any mentioned]
Then acts on ALL of them.
```

### Rule 3: Re-Read Instructions on Failure

**FORBIDDEN**

```
User: "That's not what I asked for"
Agent: "Let me try a different approach" → makes another guess
```

**REQUIRED**

```
User: "That's not what I asked for"
Agent: Re-reads the original instructions.
       Identifies what was missed or misunderstood.
       Explicitly states what the original request was.
       Then tries again addressing the actual request.
```

### Rule 4: Acknowledge Corrections Explicitly

**FORBIDDEN**

```
User: "No, I said use PostgreSQL not SQLite"
Agent: "Sure, here's the updated code" → still uses SQLite in some places
```

**REQUIRED**

```
User: "No, I said use PostgreSQL not SQLite"
Agent: "You're right, you specified PostgreSQL. Let me update ALL
       references from SQLite to PostgreSQL."
       → Changes every occurrence, not just the obvious ones
```

### Rule 5: Don't Override User Preferences with "Best Practices"

**FORBIDDEN**

```
User: "Use a simple for loop here"
Agent: "I'll use a more idiomatic approach" → uses map/filter/reduce

User: "Put this in a single file"
Agent: "For better organization..." → splits into 5 files

User: "Don't add error handling here"
Agent: "It's best practice to..." → adds error handling anyway
```

**REQUIRED**

```
User: "Use a simple for loop here"
Agent: *uses a simple for loop*

User: "Put this in a single file"
Agent: *puts it in a single file*

User: "Don't add error handling here"
Agent: *doesn't add error handling*
```

### Rule 6: Track Multi-Part Requests

**FORBIDDEN**

```
User asks for A, B, C, D, and E.
Agent does A, B, and C, then says "Done!"
```

**REQUIRED**

```
User asks for A, B, C, D, and E.
Agent tracks:
  [x] A - completed
  [x] B - completed
  [x] C - completed
  [ ] D - working on this
  [ ] E - pending
Reports completion honestly, doesn't claim "done" until all items addressed.
```

## Instruction Drift Detection

### Symptoms

| Symptom | Indicates |
|---------|-----------|
| Agent starts "improving" things the user didn't ask for | Scope drift |
| Agent changes approach mid-task without user prompting | Goal drift |
| Agent's output format doesn't match the requested format | Format drift |
| Agent addresses similar-but-different problem than stated | Topic drift |
| User says "that's not what I asked" or pastes instructions again | Comprehension failure |

### Recovery Protocol

When instruction drift is detected:

```
1. STOP current action
2. RE-READ the original user request (go back to it, don't rely on memory)
3. IDENTIFY what drifted and why
4. ACKNOWLEDGE the drift to the user
5. RESUME from the correct understanding
```

## Integration with Anti-Laziness

Instruction comprehension and anti-laziness are complementary:
- **Anti-laziness** prevents agents from taking shortcuts to "complete" a task
- **Instruction comprehension** prevents agents from completing the wrong task

Both prevent the user from having to repeat themselves. The difference:
- Anti-laziness: "You didn't finish" (agent gave up)
- Instruction comprehension: "You did the wrong thing" (agent didn't read)

## Integration with Research-Before-Decision

These rules work together:
- **Instruction comprehension**: Understand WHAT the user wants
- **Research-before-decision**: Understand HOW to accomplish it

Both must happen before the agent starts writing code.

## Integration with TAO Loop

In the Thought-Action-Observation loop:
- The first **Thought** in any task MUST parse user instructions
- **Thoughts** that reference "the user wants" must accurately reflect what the user actually said
- **Observations** after action must be compared against original instructions
- If **Observation** reveals drift from instructions, the next **Thought** must acknowledge and correct

## Platform Applicability

This rule applies universally across all AI coding platforms:
- Every supported provider
- Any agent that receives natural language instructions

Following instructions is not a feature. It is the baseline expectation.
