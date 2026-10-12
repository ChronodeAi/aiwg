# Verification contracts for research and planning

Declare expected artifacts, checks, expected outcomes, and completion evidence before dispatch. The reusable machine-readable contract is [`verification-contract.schema.json`](../agentic/code/frameworks/sdlc-complete/schemas/verification-contract.schema.json).

```yaml
expected_artifacts: [{path: report.md, required: true}]
checks:
  - {id: citations, kind: documentary, procedure: "resolve every citation", expected: "zero unresolved", required: true}
completion_evidence:
  - {check_id: citations, observed: "zero unresolved", evidence: review.log, status: pass}
```

`complete` requires every required artifact and `pass` evidence for every required check. Missing artifacts/evidence are `incomplete`. A failed check that cannot be repaired in scope or needs unavailable authority/input is `blocked`. Never report planned, skipped, `fail`, or `missing` verification as success.

**Prose uncertainty must be registered as a declared check.** The rules above govern *declared* checks, so an uncertainty written only into narrative — "no OpenReview query was run", "the camera-ready was not retrieved", "no citation census was performed" — never surfaces as `incomplete`. Nothing is violated, because the skipped verification was never registered as verification at all. The result is a provenance gap that reads as diligence. Before writing any statement of the form *"X was not checked / not retrieved / not queried / is unverified"*, register it as a check and give it an outcome: resolve it if resolving costs roughly one request against a known endpoint, otherwise record `incomplete` or `blocked` with the specific obstacle named (endpoint unknown, rate-limited after N attempts, credential required, anti-bot wall, paywalled). "I did not check" is not a terminal state; "I could not check, because that host returns HTTP 403 to this client" is. Record a null result as a null result, never as the absence of a check.

Executable changes normally need focused tests and proportionate build/type/CI evidence. Documents need schema/template validation, links, internal consistency, and a named human checkpoint for consequential judgment. Research acquisition verifies content type, checksum, metadata, and full text; induction adds REF/sidecar/GRADE lint; synthesis adds citation verification and evidence/inference/recommendation separation. Issue planning checks duplicates, dependency direction, labels, rendering, and acceptance-testability.
