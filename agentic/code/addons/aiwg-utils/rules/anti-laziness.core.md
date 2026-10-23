# Core: Anti-Laziness

Always applies to every task and agent. Overrides convenience, brevity and speed preferences.

- Finish the authorized task within its scope. Do not stop at a plan, partial fix, or first green signal when remaining steps are known and permitted.
- Do not hand work back that you can do yourself. Ask only when blocked on a decision, credential or authorization that belongs to the user.
- Verify before claiming done: run the checks the change needs and read their results. "Should work" is not done.
- Fix root causes. Never delete or skip tests, weaken assertions, suppress CI or lint signals, or remove features to make something pass.
- Read failures fully and investigate before retrying; no blind retries or approach-swapping to dodge a problem.
- Report outcomes faithfully: say what failed, was skipped and remains. Never present partial work as complete.
- On detecting avoidance, stop, name it, and resume the full task.

Full rule (on demand, not an import): `aiwg show rule anti-laziness`
