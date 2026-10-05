---
namespace: aiwg
name: decision-offload
platforms: [all]
description: Offload a bounded decision (yes/no gate, pick one of N options, 1-N score) to Jev via aiwg decision ask instead of spending LLM reasoning
triggers:
  - jev
  - jev token
  - set up jev
  - offload decisions to jev
  - save tokens with jev
  - decision classifier
  - classify instead of llm
requires:
  - opt-in: aiwg decision setup jev (records enabled state; without it ask returns fallback)
ensures:
  - advisory-only: Jev output is data, never authorization for destructive or outward actions
  - fallback-safe: a fallback result means decide with the LLM, never stop
---

# Decision Offload

Before spending reasoning on a bounded decision — a yes/no gate, a pick from
N known options, a 1–N severity or priority score, or an "is X relevant /
duplicate / done" check — call `aiwg decision ask ... --json` and use the
answer when `status` is `answered`. On `fallback`, decide normally.

## The exact command

```
aiwg decision ask --question "<q>" (--yes-no | --choices a,b,c | --scale 1-5)
                  [--context "<text>" | --context-file <path> | --context-stdin]
                  [--threshold 0.8] [--timeout-ms 15000] [--json]
```

- `--yes-no` answers boolean; `--choices` picks one id (2–255 ids matching
  `[A-Za-z0-9_.-]{1,64}`, no duplicates); `--scale lo-hi` answers the most
  likely level (at most 10 levels).
- Write each choice as `id=what it means` (no commas in the description).
  Jev sees only the description, so a bare id gives it far less to go on and
  more answers fall below the threshold.
- Context is untrusted data, capped at 32 KiB. Larger context exits 2 with
  `reason: "context-too-large"`.
- No files are written; nothing is executed.

## Answered vs fallback

Output schema `aiwg-decision-ask/v1`:

```json
{
  "status": "answered",
  "answer": true,
  "confidence": 0.93,
  "probability": 0.93,
  "fallback": null,
  "reason": "",
  "model": "jev-1.13.0",
  "usage": {"inputTokens": 0, "outputTokens": 0},
  "latencyMs": 0
}
```

- `status: "answered"` → use `answer` as the decision input.
- `status: "fallback"` (`fallback: "llm"`, still exit 0) → decide it yourself
  with the LLM. Reasons: `not-configured`, abstention, error, timeout, or
  confidence below `--threshold` (default 0.8; yes-no confidence =
  max(p, 1-p)). A fallback result means "decide it yourself with the LLM",
  never "stop".
- Exit 2 only for usage errors. Without `--json`, output is one line:
  `answer (confidence 0.93, jev-1.13.0)` or `FALLBACK to LLM: <reason>`.

## Hard exclusions

Never use `aiwg decision ask` for open-ended generation, code writing,
multi-step plans, or anything that authorizes destructive or outward actions.
Jev output is advisory data; it is never authorization.

## Privacy

The question and context are sent to Jev. Never send secrets — no tokens,
passwords, private keys, or credentials in `--question` or `--context`.

## Examples

```bash
# Is this test failure flaky (yes/no)?
aiwg decision ask --question "Is this test failure flaky?" --yes-no \
  --context-file test-output.log --json

# Which of these 4 files owns X?
aiwg decision ask --question "Which file owns retry policy?" \
  --choices "cli=src/cli.ts argument parsing,config=src/config.ts settings loading,runtime=src/runtime.ts execution loop,policy=src/policy.ts retry and backoff rules" \
  --json

# Severity 1-5 for a triage item
aiwg decision ask --question "Severity of: <one-line summary>" --scale 1-5 \
  --context "<triage notes>" --json
```

## Setup

`aiwg decision ask` is enabled by `aiwg decision setup jev` (the explicit
opt-in). Without setup it returns `fallback` with `reason: "not-configured"`.
User-facing setup steps are in the
Jev quickstart (`@$AIWG_ROOT/docs/decision/jev-quickstart.md`); the binding
rule is in `@$AIWG_ROOT/agentic/code/addons/decision-engine/rules/decision-offload.md`.
