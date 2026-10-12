# Feature PRD

Author: Synthesized from Asana, Figma, and industry standard patterns
Source: https://www.edovanroyen.com/p/the-ultimate-collection-of-prd-templates
Use When: Build, Feature Work
Don't Use When: Discovery, Validation
Best For: Eng Handoff
Audience: Engineering
Detail Level: Heavy
Time to Complete: Half day+
Artefact: Document
Advantages: Comprehensive, reduces ambiguity for engineering, covers technical detail, analytics, and rollout
Limitations: Heavy to produce, overkill for small features, assumes problem and solution are already validated

---

*The comprehensive format for when you need engineering to build with minimal ambiguity. Use after you've validated the problem (Intermission, 1-Pager) and shaped the solution (Shape Up, Kevin Yien). This is the delivery document.*

---

## TL;DR

[2-3 sentences: what it is, who it's for, expected impact.]

---

## Problem Statement

### Context

[Business and product context for why this feature is needed now.]

### Problem

[Specific problem this feature solves.]

- **Who has this problem:** [User segment]
- **How often:** [Frequency]
- **Current workarounds:** [What they do today]

### Opportunity

- For users: [Benefit]
- For business: [Benefit]

---

## Goals & Non-Goals

### Goals

1. [Primary goal with metric]
2. [Secondary goal]
3. [Tertiary goal]

### Non-Goals

1. [Non-goal 1]
2. [Non-goal 2]

---

## Success Metrics

| Metric | Baseline | Target | Timeline |
|---|---|---|---|
| [Primary metric] | [Current] | [Target] | [When] |
| [Secondary metric] | [Current] | [Target] | [When] |

### Guardrails

- [Metric we must not degrade]

---

## User Stories & Acceptance Criteria

### Story 1: [Primary Use Case]

As a [user type], I want to [action], so that [benefit].

**Acceptance Criteria:**
- [ ] Given [context], when [action], then [outcome]
- [ ] Given [context], when [action], then [outcome]
- [ ] Given [context], when [action], then [outcome]

### Story 2: [Secondary Use Case]

As a [user type], I want to [action], so that [benefit].

**Acceptance Criteria:**
- [ ] Given [context], when [action], then [outcome]
- [ ] Given [context], when [action], then [outcome]

### Edge Cases & Error States

| Scenario | Expected Behavior |
|---|---|
| [Edge case 1] | [Behavior] |
| [Edge case 2] | [Behavior] |
| [Error state] | [Error message and recovery] |

---

## Design

### User Flow

```
[Start] → [Step 1] → [Step 2] → [End State]
                 ↓
            [Alt path]
```

### Key Screens

1. **[Screen name]** — Purpose: [What user accomplishes]. Key elements: [List].
2. **[Screen name]** — Purpose: [What user accomplishes]. Key elements: [List].

### Design Assets

- Figma: [Link]
- Prototype: [Link]

---

## Technical Requirements

### Data Model

```
[Relevant data structures or schema changes]
```

### API Requirements

| Endpoint | Method | Purpose |
|---|---|---|
| [/endpoint] | [GET/POST] | [Purpose] |

### Dependencies

- [Dependency 1 — status]
- [Dependency 2 — status]

### Performance Requirements

- [Load time target]
- [Scalability requirement]

### Security Considerations

- [Data sensitivity]
- [Access control]

---

## Analytics & Instrumentation

### Events

| Event Name | Trigger | Properties |
|---|---|---|
| `[event_name]` | [When fired] | [Data captured] |
| `[event_name]` | [When fired] | [Data captured] |
| `[event_name]` | [When fired] | [Data captured] |

---

## Rollout Plan

### Phase 1: Internal Testing

- [ ] QA testing
- [ ] Dogfooding
- [ ] Fix critical issues

### Phase 2: Beta

- [ ] [X]% of users
- [ ] Monitor metrics
- [ ] Collect feedback

### Phase 3: General Availability

- [ ] Full rollout
- [ ] Documentation
- [ ] Support enablement

### Feature Flag

- Flag name: [name]
- Segments: [who gets it when]

### Rollback Criteria

- If [metric] drops below [threshold], roll back

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| [Risk 1] | [H/M/L] | [H/M/L] | [Plan] |
| [Risk 2] | [H/M/L] | [H/M/L] | [Plan] |

---

## Open Questions

- [ ] [Question 1] — Owner: [Name]
- [ ] [Question 2] — Owner: [Name]

---

## Timeline

| Milestone | Target Date | Owner |
|---|---|---|
| Design complete | [Date] | [Name] |
| Dev complete | [Date] | [Name] |
| QA complete | [Date] | [Name] |
| Launch | [Date] | [Name] |

---

## Appendix

### Research

- [Link to research]

### Competitive Analysis

- [How competitors handle this]

### Alternatives Considered

- [Option A] — Not chosen because [reason]
- [Option B] — Not chosen because [reason]

---

*Owner: [Name] | Last updated: [Date]*
