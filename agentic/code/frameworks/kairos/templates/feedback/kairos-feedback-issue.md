---
name: kairos-feedback-issue
description: Issue body for ChronodeAi/kairos generated from an evidence-complete finding
---

# Kairos feedback issue

Generate with `node <framework>/scripts/kairos-records.mjs issue-body <finding.json>`. The sections match the
`ChronodeAi/kairos` bug-report form (`.github/ISSUE_TEMPLATE/bug_report.yml`: Description, Steps to Reproduce,
Environment, Relevant Logs).

Title: `<surface>: <discrepancy in one line>` (for example `rest: POST /api/v1/resolve returns an empty trace`).
Labels: `bug` and `triage`; `documentation` for doc drift.

### Description
What the documentation says (file:line at the tag, short quote), expected, observed, claim id and known gap.

### Steps to Reproduce
```sh
<exact command, token as $KAIROS_API_TOKEN>
```

### Environment
Kairos version, profile, `/api/v1/meta` sha256. Node origin only when it is loopback.

### Relevant Logs
```text
<raw output excerpt>
```
Output sha256, HTTP status, recorded at, severity, kind.

`<!-- kairos-finding-fingerprint: <sha256> -->` stays as the last line so later runs can find the issue.

Repository: exactly `ChronodeAi/kairos`. Never a fork, mirror or local clone.
