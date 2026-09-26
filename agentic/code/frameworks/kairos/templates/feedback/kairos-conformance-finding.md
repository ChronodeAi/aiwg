---
name: kairos-conformance-finding
description: Record one Kairos conformance failure, friction point, bug or doc drift with fileable evidence
---

# Kairos Finding

Authoritative record: `.aiwg/kairos/findings/<finding_id>.json` (`kairos_finding/v1`,
`schemas/finding.schema.json`). Check it with `node <framework>/scripts/kairos-records.mjs fileable`.

Finding id / kind (conformance, friction, bug, doc_drift) / severity / claim id / known gap (C1, C2, C4, C6, ...)
/ surface (rest, mcp, agent_tools, cli, docs, installer, ui) / recorded at (UTC):

Title (one line, states the discrepancy):

Command (exact; token as `$KAIROS_API_TOKEN`):
```sh
```

Output excerpt (raw) / output sha256 / HTTP status / saved path:
```text
```

Documentation citation: `file:line[-line]` at tag or commit, with a short quote:

Expected (from the citation):
Observed (from the output):

Node: origin / version / profile / `/meta` sha256.
Fingerprint (computed, never typed): `node <framework>/scripts/kairos-records.mjs fingerprint <finding.json>`.
Triage status (open, filed, duplicate, wont_file) / issue number and URL / triage note:

Mark anything not observed as `[INFERENCE]`. No finding without command, output, citation, and expected versus observed.
