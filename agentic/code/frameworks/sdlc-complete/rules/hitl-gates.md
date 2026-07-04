---
enforcement: high
---

# Human-in-the-Loop Gate Rules

**Enforcement Level**: HIGH
**Scope**: All SDLC phase transitions and critical checkpoints
**Research Basis**: REF-057 Agent Laboratory (HITL draft-then-edit: 84% cost reduction, 0.83 vs 4.2 revision cycles)
**Issue**: #96

## Gate Types

| Type | Behavior |
|------|----------|
| `approval` | Blocks until a human approves (phase transitions, major decisions) |
| `review` | Human reviews; auto-proceeds on timeout (artifact quality checks) |
| `escalation` | Triggered by conditions (budget overruns, confidence drops) |
| `checkpoint` | Informational; always proceeds (progress updates) |

## Mandatory Rules

### Rule 1: Phase Transitions Require Gates
Every SDLC phase transition MUST have an approval gate with `mode: ALWAYS`: GATE-C2I (Concept→Inception), GATE-I2E (Inception→Elaboration), GATE-E2C (Elaboration→Construction), GATE-C2T (Construction→Transition).

### Rule 2: Gate Modes
`ALWAYS` (critical/security/compliance), `CONDITIONAL` (auto-approve under explicit conditions), `NEVER` (only for fully automated pipelines with human oversight elsewhere), `TERMINATE` (stop and wait indefinitely).

### Rule 3: Timeout Actions
Configure per gate: approval → `block`; review → `proceed`; budget → `abort`.

### Rule 4: Cost Tracking is REQUIRED
Every gate tracks `time_to_decision`, `revision_count`, `token_cost_saved`.

### Rule 5: Audit Trail
Every gate decision is logged with rationale (~90-day retention).

### Rule 6: Auto-Approve Conditions Must Be Explicit
`CONDITIONAL` mode without stated `auto_approve_conditions` is FORBIDDEN. Each condition needs an explicit predicate and a reason (e.g. `confidence > 0.95 AND no_critical_issues` — "high confidence, no blockers").

### Rule 7: Presentation Must Aid Decision
Gates present enough context to decide: artifacts ready, quality score, open issues, the action required, the artifacts to show, and a required question with explicit options.

### Rule 8: Artifact Omission Requires Human Approval
Agents MUST NOT silently skip, abbreviate, or omit any SDLC artifact based on inferred project type/size/complexity — completeness is the default. To skip an artifact, surface an `ALWAYS`/`block` gate ("Skip generating {{artifact}}?" → No-generate-it (recommended) / Yes-skip / generate-abbreviated). Implicit skips produce inconsistent artifact sets and erode trust; the human must explicitly opt out.

## SDLC Phase Gates

| Gate | Timeout→block | Artifacts | Question |
|------|---------------|-----------|----------|
| GATE-C2I | 48h | intake form, solution profile | Scope approved? |
| GATE-I2E | 48h | user stories, use cases, risk register | Requirements complete? |
| GATE-E2C | 48h | SAD, ADRs, test strategy | Architecture approved? |
| GATE-C2T | 24h | test results, deployment plan, security assessment | Ready for production? |

All gates conform to `@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/schemas/flows/hitl-gate.yaml`. Integrates with flow commands (exit gates), agent loops (iteration-count checkpoint gates), and cost budgets (cost-threshold gates with `timeout_action: abort`). Notify via configured channels (cli, issue_comment, slack) with the gate name, action required, and timeout remaining.

## Integration Patterns

### With Flow Skills

```yaml
# In flow skill definition
flow_phases:
  - name: elaboration
    exit_gate: GATE-E2C
    gate_config:
      mode: ALWAYS
      notification:
        channels: [cli, issue_comment]
```

### With Agent Loop

```yaml
# Al iteration checkpoint
ralph_config:
  iteration_gate:
    trigger:
      type: iteration_count
      threshold: 10
    behavior:
      mode: CONDITIONAL
      auto_approve_conditions:
        - condition: "progress_rate > 0.1"
          reason: "Making progress"
```

### With Cost Budgets

```yaml
# Budget checkpoint gate
budget_gate:
  trigger:
    type: cost_threshold
    threshold: 1000  # tokens
  behavior:
    mode: ALWAYS
    timeout_action: abort
```

## Cost Savings Model

Based on Agent Laboratory research:

| Metric | Fully Autonomous | With HITL | Savings |
|--------|------------------|-----------|---------|
| Cost multiplier | 6.0x | 1.0x | 84% |
| Error rate | 35% | 5% | 86% |
| Revision cycles | 4.2 | 0.83 | 80% |

## Notification Configuration

Configure how humans are notified:

```yaml
notification:
  channels:
    - cli           # Show in terminal
    - issue_comment # Post to issue
    - slack         # Send Slack message (if configured)
  urgency: high
  message_template: |
    **Gate Activated**: {{gate_name}}
    **Action Required**: {{action_type}}
    **Timeout**: {{timeout_remaining}}
```

## Artifact Omission Gate Template

**REQUIRED**: Agents MUST NOT silently skip, abbreviate, or omit any SDLC artifact based on inferred project type, size, or complexity. Completeness is the default.

When an agent determines an artifact is low-value for the project context, it MUST surface a HITL gate:

```yaml
artifact_omission_gate:
  trigger:
    type: agent_skip_request
    artifact: "{{artifact_name}}"
  behavior:
    mode: ALWAYS
    timeout_action: block
  presentation:
    summary_template: |
      ## Artifact Omission Request

      **Artifact**: {{artifact_name}}
      **Phase**: {{current_phase}}
      **Reason**: {{agent_rationale}}

      The agent suggests this artifact may not be needed for this project.
      However, completeness is the default — skipping requires your approval.

    questions:
      - id: "skip_approved"
        question: "Skip generating {{artifact_name}}?"
        options:
          - "No — generate it (recommended)"
          - "Yes — skip this artifact"
          - "Generate abbreviated version"
        required: true
```

**Rationale**: Implicit decisions to skip documentation based on project type inference produce inconsistent, incomplete artifact sets and erode trust. The human must explicitly opt out of any artifact.

## Checklist

Gate type matches use case; mode appropriate for risk; timeout + timeout_action configured; cost tracking enabled; audit logging enabled; presentation aids the decision; auto-approve conditions justified (if CONDITIONAL).

## References

- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/schemas/flows/hitl-gate.yaml
- @.aiwg/research/findings/REF-057-agent-laboratory.md
- #96

---

**Rule Status**: ACTIVE
**Last Updated**: 2026-01-25
