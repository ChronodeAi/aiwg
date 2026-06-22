# No Self-Grading

## Rule

An agent, optimizer, harness, or generated worker must not be accepted on the basis of an evaluator,
criterion, policy, rubric, memory record, or promotion path it can edit or redefine.

## Enforcement Guidance

- Keep producer and grader roles structurally separate.
- Treat same-process, same-user, or same-worktree grading as development-only unless a separate trusted
  verifier rechecks the result.
- Do not let generated reports, self-written status, or advisory event logs mint acceptance.
- Require an external or protected verifier for promotion, merge, deployment, or arming decisions.

## Failure Smell

If the candidate can alter the question, the scorer, the answer key, the benchmark corpus, the policy
file, or the promotion rule, the result is not a trustworthy pass.
