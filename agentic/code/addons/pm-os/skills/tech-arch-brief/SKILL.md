---
name: tech-arch-brief
description: >-
  Use when you have a PRD and need a Technical Architecture Brief — system context, component architecture, tech-stack rationale, and risk mitigation — where every architecture *trade-off* names the requirement that drives it and the condition that would reverse it. Not for finding the application's shape or archetype (`eng-shape`), translating a decided technical plan for stakeholders (`tech-to-business`), or writing the PRD itself (`prd-draft`).
---

# Turn a PRD into a technical architecture brief

## Step 1 — Pull the architecture-driving requirements from the PRD

Extract what actually shapes the architecture: expected scale, latency needs, data sensitivity, required integrations, team size and skills. Anything the PRD doesn't state, flag as an assumption rather than inventing a number.

Done when the driving requirements are listed, with unstated ones flagged as assumptions.

## Step 2 — System context

Name the bounded contexts (user management, payments, …), how they interact, and the third-party integrations each needs.

Done when the contexts, their interactions, and required integrations are named.

## Step 3 — Component architecture

Make the monolith-vs-services call and the database choice, each tied to a Step-1 requirement — not to fashion — and sketch the data flow between components.

Done when the architecture and database choices each cite the requirement that drives them, and the data flow is sketched.

## Step 4 — Tech stack rationale

Recommend frontend, backend, infrastructure, and CI/CD, each justified by a named factor (scale, hiring, ecosystem) and matched to the team's size and skills.

Done when every stack choice names its deciding factor.

## Step 5 — Risk mitigation

Name the single points of failure, a redundancy for each, and a rough compute/storage cost at expected scale. Every major call names the condition that would reverse it.

Done when each single point of failure has a mitigation, a rough cost is given, and the big calls carry reversal conditions.

## Output

Resolve the save path with `bash bin/memory/resolve-project.sh --project {slug} --json`, then write to `{project_path}/YYMMDD-tech-arch-brief-{product-slug}.md`. Never hand-build the path.

The doc holds: the driving requirements with assumptions flagged, the system context, the component architecture, the stack rationale, and the risk-mitigation plan with reversal conditions.
