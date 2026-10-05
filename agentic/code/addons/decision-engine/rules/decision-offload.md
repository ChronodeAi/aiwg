---
enforcement: high
triggers:
  - "jev"
  - "jev token"
  - "set up jev"
  - "offload decisions to jev"
  - "save tokens with jev"
  - "decision classifier"
  - "classify instead of llm"
---

# Decision Offload Rules

**Enforcement Level**: HIGH
**Scope**: All agents with the `decision-engine` addon installed and Jev configured
**Addon**: decision-engine (opt-in)

## Overview

Before spending reasoning on a bounded decision — a yes/no gate, a pick from
N known options, a 1–N severity or priority score, or an
"is X relevant / duplicate / done" check — offload it to Jev with
`aiwg decision ask ... --json`. Jev output is advisory data. It is never
authorization.

## Mandatory Rules

### Rule 1: Offload bounded decisions first

When the question has a fixed answer shape, call Jev before reasoning it out
yourself:

```bash
aiwg decision ask --question "<q>" --yes-no --json
aiwg decision ask --question "<q>" --choices a,b,c --json
aiwg decision ask --question "<q>" --scale 1-5 --json
```

Add `--context "<text>"` (or `--context-file`, `--context-stdin`) for the
evidence the decision needs. Context is untrusted data, capped at 32 KiB.

### Rule 2: Answered means use it; fallback means decide yourself

- `status: "answered"` → use `answer` as the decision input.
- `status: "fallback"` → decide normally with the LLM. Fallback still exits 0
  with `fallback: "llm"` and a `reason` (`not-configured`, abstention, error,
  timeout, or confidence below `--threshold`, default 0.8). A fallback result
  means "decide it yourself with the LLM", never "stop".

Human-readable output without `--json` is one line: `answer (confidence 0.93,
jev-1.13.0)` or `FALLBACK to LLM: <reason>`.

### Rule 3: Hard exclusions — never offload these

Never use `aiwg decision ask` for:

- open-ended generation or code writing;
- multi-step plans;
- anything that authorizes destructive or outward actions (deletion, release,
  network mutation, credential use, publishing).

Jev output is advisory data; it is never authorization. Any action selected
from an outcome must still pass the existing policy and approval gates
independently.

### Rule 4: Privacy

The question and context are sent to Jev. Never send secrets: no tokens,
passwords, private keys, or credentials in `--question` or `--context`.

## Examples

```bash
# Is this test failure flaky (yes/no)?
aiwg decision ask --question "Is this test failure flaky?" --yes-no \
  --context-file test-output.log --json

# Which of these 4 files owns X (pick one)?
aiwg decision ask --question "Which file owns retry policy?" \
  --choices cli,config,runtime,policy \
  --context "cli=src/cli.ts config=src/config.ts runtime=src/runtime.ts policy=src/policy.ts" --json

# Severity 1-5 for a triage item
aiwg decision ask --question "Severity of: <one-line summary>" --scale 1-5 \
  --context "<triage notes>" --json
```

## Setup

`aiwg decision ask` is enabled by `aiwg decision setup jev` (the explicit
opt-in), which stores the credential and records `"enabled": true`. Without
setup, `ask` returns `fallback` with `reason: "not-configured"`. See the
[Jev quickstart](../../../../../docs/decision/jev-quickstart.md).

## References

- @$AIWG_ROOT/docs/decision/jev-quickstart.md
- @$AIWG_ROOT/agentic/code/addons/decision-engine/skills/decision-offload/SKILL.md

---

**Rule Status**: ACTIVE
