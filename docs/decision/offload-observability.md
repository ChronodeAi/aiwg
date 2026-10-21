# Inspect decision offload

Decision offload reporting is local and advisory. It reads configuration metadata,
the completed-call ledger and the opportunity journal. Inspection never probes
Jev, sends a prompt, authorizes an action or blocks useful work.

```bash
aiwg status --json
aiwg doctor --decision-offload --json
aiwg steward decision-offload --json
```

All three reports expose the same `decisionOffload` snapshot. Doctor's explicit
mode runs only this offline inspection; its normal text report also includes the
section. Worker-probe JSON adds the same snapshot beside the worker results.

Ask readiness and runtime-evaluate readiness are separate. Saved Jev setup can
make advisory ask available while runtime evaluation is disabled. A configured
installation is unprobed until there is attributable evidence; an old successful
call cannot override a current explicit disable. Reported evidence is scoped to
the named session or recent window, not all hosts or all sessions.

Completed calls include answered and fallback results, fallback reasons and
estimated token counts. Estimated LLM tokens avoided are an estimate, not a
measurement of realized savings. Diagnostic, setup and benchmark callers are
reported separately and cannot clear an organic-adoption warning.

The opportunity journal describes only checkpoints using the shared invocation
contract: eligibility, attempt, answer/fallback/skip/unknown, reason and correlation
to the completed-call ledger. A fallback is an attempt. A usage rejection, missing
record or unreadable journal is not evidence that no invocation occurred.
Generic activity-log prose cannot establish a precise denominator of eligible
decisions. No observed eligible work is different from healthy adoption.

Drift hints are advisory. Missing delivery or startup anchors, observed eligible
work without attempts, repeated fallback and recording uncertainty require
different remedies. Inspect the readiness, coverage and activation sections
before changing thresholds or repeating a question. Provider-native loading is
unknown unless independently verified; a copied rule file is only delivery
evidence. Free-form harness actions outside AIWG's executable checkpoints remain
instruction-only coverage.

For a complete applicable-rule inventory, use the scoped rule inventory commands
in the CLI reference. Inventory does not establish that a provider loaded every
listed rule into its session.

Advisory thresholds live in project configuration under `decision.offload_report`:
`window_hours`, `minimum_eligible`, `minimum_attempt_rate` and `repeated_fallbacks`.
They change reporting only; they do not enable a service, schedule calls or stop
work. Invalid settings are reported as unknown rather than silently treated as
healthy observation.
