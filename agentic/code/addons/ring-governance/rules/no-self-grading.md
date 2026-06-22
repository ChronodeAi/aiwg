# No Self-Grading

**Enforcement Level**: HIGH
**Scope**: Agentic work acceptance, optimizer outputs, generated workers, harness results,
promotion gates, arming decisions, and issue-closing claims.
**Addon**: ring-governance
**Status**: DRAFT

## Rule

An agent, optimizer, harness, or generated worker must not be accepted on the basis of an evaluator,
criterion, policy, rubric, memory record, or promotion path it can edit or redefine.

## Decision Surfaces

This rule applies to any surface that can convert work into an accepted state, including pass/fail
results, PR readiness, deployment permission, arming status, benchmark success, issue closure, and
claims that a goal has been completed.

## Enforcement Guidance

- Keep producer and grader roles structurally separate.
- Treat same-process, same-user, or same-worktree grading as development-only unless a separate trusted
  verifier rechecks the result.
- Do not let generated reports, self-written status, or advisory event logs mint acceptance.
- Require an external or protected verifier for promotion, merge, deployment, or arming decisions.
- Require verdicts to cite primary evidence and the exact candidate artifact or tree.
- Fail closed when the producer can alter the evaluator, criteria, evidence set, parser, threshold, or
  promotion rule.

## Allowed Development Use

Self-checks are allowed as fast feedback when labeled development-only. They must not be presented as
final acceptance unless a protected verifier independently rechecks the result.

## Failure Smell

If the candidate can alter the question, the scorer, the answer key, the benchmark corpus, the policy
file, or the promotion rule, the result is not a trustworthy pass.
