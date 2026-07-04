---
enforcement: medium
paths:
  - ".aiwg/**"
  - "AIWG.md"
  - "AGENTS.md"
  - "CLAUDE.md"
---

# SDLC Orchestration Rules

**Enforcement Level**: MEDIUM
These rules apply when working with AIWG SDLC artifacts, workflow skills, flow skills, and workflow commands.

## Core Platform Orchestrator Role

**IMPORTANT**: The active assistant in the current provider is the **Core Orchestrator** for SDLC
workflows, not a provider-shortcut executor. This rule applies across Claude Code, Factory, and
Codex CLI.

### Orchestration Responsibilities

When users request SDLC workflows by natural language or by naming a skill:

#### 0. Right-size before launching anything

**REQUIRED**: Before invoking any intake, flow, or phase-transition skill, apply the right-sizing heuristic from the `sdlc-right-sizing` rule:

- Most changes do NOT need intake, Inception, or phase-gate flows
- Issues + (optional) ADR is the right answer for small / medium features
- Reserve intake and full SDLC flows for: new addons/frameworks/tracks, refactors crossing module boundaries, work meeting ≥2 of the trigger criteria

If the user did NOT explicitly request intake/Inception ("start an intake", "run inception", "let's plan this properly"), default to the lightest sufficient artifact set. When unsure, ask ONE specific question — do not present a multi-option menu of "intake, plan, ADR, full pipeline."

See `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/sdlc-right-sizing.md` for the full heuristic, trigger criteria, and signal-interpretation table.

#### 1. Interpret Natural Language

Map user requests to flow templates:

- "Let's transition to Elaboration" -> `flow-inception-to-elaboration`
- "Start security review" -> `flow-security-review-cycle`
- "Create architecture baseline" -> Extract SAD generation from flow
- "Run iteration 5" -> `flow-iteration-dual-track` with iteration=5

See full translation table:
`@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/docs/simple-language-translations.md`

#### 2. Read Flow Skills as Orchestration Templates

Flow skills are **not bash scripts to execute**. They are orchestration guides containing:

- **Artifacts to generate**: What documents/deliverables
- **Agent assignments**: Who is Primary Author, who reviews
- **Quality criteria**: What makes a document "complete"
- **Multi-agent workflow**: Review cycles, consensus process
- **Archive instructions**: Where to save final artifacts

Resolve the active workflow with `aiwg discover "<intent>"` and `aiwg show skill <name>`. Provider
prompts, shortcuts, or legacy slash-command views are compatibility surfaces over the skill corpus;
the skill is the canonical source.

#### 3. Launch Multi-Agent Workflows via Provider-Native Delegation

**Follow this pattern for every artifact**:

```text
Primary Author -> Parallel Reviewers -> Synthesizer -> Archive
     |                |                    |           |
  Draft v0.1    Reviews (3-5)      Final merge    .aiwg/archive/
```

Use the active provider's native delegation mechanism:

- Claude Code: multiple Task tool calls in one assistant message when parallel review is warranted.
- Factory: Factory-native agent/delegation primitives when available; otherwise run the same review
  sequence serially with explicit reviewer roles.
- Codex CLI: use available subagent tooling when present; otherwise perform the review inline and
  clearly label the provider fallback.

Respect the workspace parallelism cap in `AGENTS.md` / AIWG context. If the provider cannot launch
parallel reviewers, preserve the review pattern and record that execution was serial or inline.

#### 4. Track Progress and Communicate

Update user throughout with clear indicators:

```text
[OK] = Complete
[..] = In progress
[XX] = Error/blocked
[!!] = Warning/attention needed
```

## Natural Language Skill Routing

Users usually use natural language. When they name a legacy slash command or provider shortcut, treat
it as an alias for the corresponding AIWG skill and resolve it through `aiwg discover` / `aiwg show`.

### Common Phrases

**Phase Transitions**:
- "transition to {phase}" | "move to {phase}" | "start {phase}"
- "ready to deploy" | "begin construction"

**Workflow Requests**:
- "run iteration {N}" | "start iteration {N}"
- "deploy to production" | "start deployment"

**Review Cycles**:
- "security review" | "run security" | "validate security"
- "run tests" | "execute tests" | "test suite"
- "check compliance" | "validate compliance"
- "performance review" | "optimize performance"

**Artifact Generation**:
- "create {artifact}" | "generate {artifact}" | "build {artifact}"
- "architecture baseline" | "SAD" | "ADRs"
- "test plan" | "deployment plan" | "risk register"

**Status Checks**:
- "where are we" | "what's next" | "project status"
- "can we transition" | "ready for {phase}" | "check gate"

**Team and Process**:
- "onboard {name}" | "add team member"
- "knowledge transfer" | "handoff to {name}"
- "retrospective" | "retro" | "hold retro"

**Operations**:
- "incident" | "production issue" | "handle incident"
- "hypercare" | "monitoring" | "post-launch"

### Response Pattern

**Confirm understanding before starting only when the request is ambiguous or the workflow is
materially heavy.** If the user explicitly asks for a known flow, skill, or phase transition, act
after applying right-sizing and discovery.

```text
User: "Let's transition to Elaboration"

You: "Understood. I'll orchestrate the Inception -> Elaboration transition.

This will generate:
- Software Architecture Document (SAD)
- Architecture Decision Records (3-5 ADRs)
- Master Test Plan
- Elaboration Phase Plan

I'll coordinate the appropriate provider-native reviewers for comprehensive review.
Starting orchestration..."
```

## Skill Discovery

The examples below are common SDLC capabilities, not an exhaustive skill registry. Prefer
`aiwg discover "<intent>"` followed by `aiwg show skill <name>` so Claude Code, Factory, and Codex CLI
all resolve the same canonical AIWG surface even when provider shortcut directories differ.

**Intake & Inception**:
- `intake-wizard` - Generate or complete intake forms
- `intake-from-codebase` - Analyze existing codebase
- `intake-start` - Kick off Inception phase
- `flow-concept-to-inception` - Concept -> Inception workflow

**Phase Transitions**:
- `flow-inception-to-elaboration` - To Elaboration
- `flow-elaboration-to-construction` - To Construction
- `flow-construction-to-transition` - To Transition

**Continuous Workflows**:
- `flow-risk-management-cycle` - Risk identification
- `flow-requirements-evolution` - Requirements refinement
- `flow-architecture-evolution` - Architecture changes
- `flow-test-strategy-execution` - Test execution
- `flow-security-review-cycle` - Security validation
- `flow-performance-optimization` - Performance tuning

**Quality & Gates**:
- `flow-gate-check <phase>` - Validate gate criteria
- `flow-handoff-checklist <from> <to>` - Handoff validation
- `project-status` - Current phase and progress
- `project-health-check` - Health metrics

**Team & Process**:
- `flow-team-onboarding <member> [role]`
- `flow-knowledge-transfer <from> <to> [domain]`
- `flow-cross-team-sync <team-a> <team-b>`
- `flow-retrospective-cycle <type> [iteration]`

**Deployment & Operations**:
- `flow-deploy-to-production`
- `flow-hypercare-monitoring <days>`
- `flow-incident-response <id> [severity]`

**Compliance & Governance**:
- `flow-compliance-validation <framework>`
- `flow-change-control <type> [id]`
- `check-traceability <path>`
- `security-gate`

### Skill Arguments

Flow skills commonly support:
- `[project-directory]` - Path to project root (default: `.`)
- `--guidance "text"` - Strategic guidance
- `--interactive` - Interactive mode

## AIWG-Specific Rules

1. **Artifact Location**: All SDLC artifacts MUST be in `.aiwg/` subdirectories
2. **Template Usage**: Use templates from `$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/`
3. **Agent Orchestration**: Follow Primary Author -> Reviewers -> Synthesizer -> Archive, using
   provider-native parallelism when available
4. **Phase Gates**: Validate gate criteria before transitioning
5. **Traceability**: Maintain requirements -> code -> tests -> deployment links
6. **Guidance First**: Use `--guidance` or `--interactive` upfront
7. **Parallel Execution**: Launch independent reviewers in one provider-native batch when supported;
   otherwise run them serially and disclose the fallback
8. **Wire-As-You-Go**: Include @-mentions in generated artifacts when the provider supports them; use
   plain `$AIWG_ROOT/...` paths otherwise
9. **Right-Sized Completeness**: Once a workflow is selected, do not silently omit artifacts required by
   that workflow. But do not launch a heavier workflow merely to satisfy a "complete docset" reflex.
   Apply `sdlc-right-sizing` first; completeness applies inside the chosen artifact set.

## Phase Overview

**Inception** (4-6 weeks): Validate problem, vision, risks. Architecture sketch, ADRs. Security screening. Business case. **Milestone**: Lifecycle Objective (LO)

**Elaboration** (4-8 weeks): Detailed requirements. Architecture baseline. Risk retirement (PoCs). Test strategy, CI/CD. **Milestone**: Lifecycle Architecture (LA)

**Construction** (8-16 weeks): Feature implementation. Automated testing. Security validation. Performance optimization. **Milestone**: Initial Operational Capability (IOC)

**Transition** (2-4 weeks): Production deployment. UAT. Support handover. Hypercare monitoring. **Milestone**: Product Release (PR)

**Production** (ongoing): Operational monitoring. Incident response. Feature iteration. Continuous improvement.

## Reference Documentation

For detailed documentation, use @-mentions:
- `@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/docs/orchestrator-architecture.md`
- `@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/docs/multi-agent-documentation-pattern.md`
- `@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/docs/simple-language-translations.md`
