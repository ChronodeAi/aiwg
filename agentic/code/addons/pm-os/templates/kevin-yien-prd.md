# Kevin Yien's Stage-Gated PRD

Author: Kevin Yien (ex-Square PM)
Source: Referenced in https://www.lennysnewsletter.com/p/my-favorite-templates-issue-37
Review: https://www.edovanroyen.com/p/the-ultimate-collection-of-prd-templates
Use When: Planning, Feature Work
Don't Use When: Discovery, Quick Alignment
Best For: Scope Definition, Stakeholder Alignment
Audience: Cross-Functional
Detail Level: Medium
Time to Complete: 2-4 hours (grows across stages)
Artefact: Document
Advantages: Stage-gated lifecycle, built-in review checkpoints, solution defined as perimeter not spec, scales from draft to launched
Limitations: Assumes problem is already understood, too heavy for quick alignment, requires review culture

---

*"Think of this like drawing the perimeter of the solution space. Draw the boundaries so the team can focus on how to fill it in." — Kevin Yien*

*This PRD has 5 lifecycle stages. Don't fill in everything at once — the document grows as the project progresses through each stage.*

---

## Status

- [ ] **Draft** — initial thinking, not yet reviewed
- [ ] **Problem Review** — aligned on the problem
- [ ] **Solution Review** — aligned on the approach
- [ ] **Launch Review** — ready to ship
- [ ] **Launched** — live, measuring results

---

## Contributors & Reviewers

| Role | Name | Reviewed? |
|---|---|---|
| PM (Owner) | [Name] | — |
| Engineering Lead | [Name] | [ ] |
| Design Lead | [Name] | [ ] |
| Data/Analytics | [Name] | [ ] |
| [Stakeholder] | [Name] | [ ] |

---

## Problem

[What problem are we solving? For whom? Write this from the user's perspective.]

**Who experiences this problem:**
[User segment]

**How we know it's a problem:**
[Evidence — data, research, support tickets, user quotes]

**What happens if we don't solve this:**
[Cost of inaction]

---

*⏸️ STOP — Review the problem with contributors before continuing to solution.*

---

## Hypothesis

[If we do X, we believe Y will happen, and we'll measure it by Z.]

---

## Goals

1. [Primary goal — with metric]
2. [Secondary goal]
3. [Tertiary goal]

### Non-Goals

*What are we explicitly NOT trying to achieve?*

1. [Non-goal 1 — why it's out of scope]
2. [Non-goal 2 — why it's out of scope]

---

## Solution

*Draw the perimeter. Define what's inside the boundary and what's outside. Leave room for the team to fill in the details.*

### What's In

[Describe the solution at the level of user-facing behavior. What will the user be able to do?]

- [Capability 1]
- [Capability 2]
- [Capability 3]

### What's Out

[Explicitly name what's not included in this scope.]

- [Exclusion 1]
- [Exclusion 2]

### Key Flows

[Describe the primary user flow at a high level.]

```
[Start] → [Step 1] → [Step 2] → [End state]
```

### Open Design Questions

- [Question 1 — who owns resolving it]
- [Question 2 — who owns resolving it]

---

*⏸️ STOP — Review the solution with contributors before continuing to launch planning.*

---

## Success Metrics

| Metric | Baseline | Target | When |
|---|---|---|---|
| [Primary metric] | [Current] | [Goal] | [Timeline] |
| [Secondary metric] | [Current] | [Goal] | [Timeline] |

### Guardrails

- [Metric we must not degrade]

---

## Launch Plan

### Rollout

| Phase | Audience | Duration | Success Criteria |
|---|---|---|---|
| Internal/Dogfood | Team | [Time] | [Criteria] |
| Beta | [X%] of users | [Time] | [Criteria] |
| GA | All users | [Time] | [Criteria] |

### Rollback Criteria

- If [metric] drops below [threshold], pause rollout

### Dependencies

- [Dependency 1 — status]
- [Dependency 2 — status]

---

*⏸️ STOP — Review launch plan with contributors before shipping.*

---

## Post-Launch

*Fill in after launch.*

**Launch date:** [Date]

**Results vs. targets:**

| Metric | Target | Actual | Notes |
|---|---|---|---|
| [Metric 1] | [Target] | [Actual] | [Interpretation] |
| [Metric 2] | [Target] | [Actual] | [Interpretation] |

**Learnings:**
- [What we learned]

**Next iteration:**
- [What comes next based on results]

---

*Owner: [Name] | Date: [Date]*
