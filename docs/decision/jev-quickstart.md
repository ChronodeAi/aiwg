# Jev Quickstart

Jev offloads bounded decisions — a yes/no gate, a pick from N known options,
or a 1–N severity or priority score — so the LLM does not spend reasoning on
questions with a fixed answer shape. `aiwg decision ask` sends one question
plus optional context and returns a typed answer with confidence, or a
fallback that means "decide it yourself with the LLM".

Savings vary by workload: offloading helps when you ask many small bounded
questions and decide normally on fallback.

## 1. Install

```bash
npm i -g aiwg@latest
aiwg use decision-engine
```

The `decision-engine` addon is opt-in and excluded from bulk installs
(`aiwg use all`, framework deploys).

## 2. Store the token

`aiwg decision setup jev` counts as the explicit opt-in that enables `ask`.
It stores the credential and records `"enabled": true` in the credential file.
Pipe the token through stdin so it never appears in shell history:

```bash
printf '%s' "$TOKEN" | aiwg decision setup jev --token-stdin --verify
```

Token lookup order when running `ask`:

1. env `JEV_API_KEY`,
2. env `AIWG_DECISION_JEV_API_KEY`,
3. the user credential file
   `${XDG_CONFIG_HOME:-~/.config}/aiwg/credentials/jev.json`
   (`{"token":"...","region":"us","endpoint"?:...}`, mode 0600, parent dir
   0700 — a group- or world-readable file is refused).

`setup` prints `aiwg-decision-jev-setup/v1` JSON:
`{ configured, credentialSource: "file"|"env", region, verified?, model?,
next: [...] }`. The token is never printed, logged, or written to results or
project files. Region defaults to `"us"`; change it with `--region`. The
endpoint is the official `https://api.typesafe.ai/v1/systemone` unless
`--endpoint` names a custom origin that passes the adapter allowlist rules.

## 3. Verify

```bash
printf '%s' "$TOKEN" | aiwg decision setup jev --token-stdin --verify
```

`--verify` makes one tiny live yes/no call and reports status, model, and
usage. Without `--token-stdin`, `setup` uses the env token if one is present
and otherwise exits 2 with instructions.

## 4. Ask

```
aiwg decision ask --question "<q>" (--yes-no | --choices a,b,c | --scale 1-5)
                  [--context "<text>" | --context-file <path> | --context-stdin]
                  [--threshold 0.8] [--timeout-ms 15000] [--json]
```

```bash
# Yes/no gate
aiwg decision ask --question "Is this test failure flaky?" --yes-no \
  --context-file test-output.log --json

# Pick one of N known options
aiwg decision ask --question "Which file owns retry policy?" \
  --choices cli,config,runtime,policy \
  --context "cli=src/cli.ts config=src/config.ts runtime=src/runtime.ts policy=src/policy.ts" --json

# 1-5 severity score
aiwg decision ask --question "Severity of: null deref in login handler" \
  --scale 1-5 --context "<triage notes>" --json
```

`--choices` takes 2–255 ids matching `[A-Za-z0-9_.-]{1,64}` with no
duplicates; `--scale lo-hi` allows at most 10 levels. Context is untrusted
data capped at 32 KiB — larger context exits 2 with
`reason: "context-too-large"`. Nothing is written and nothing is executed.

Without `--json`, output is one line: `answer (confidence 0.93, jev-1.13.0)`
or `FALLBACK to LLM: <reason>`.

## 5. How agents use it

The `decision-offload` rule (with the `decision-offload` skill) says: before
spending reasoning on a bounded decision, call `aiwg decision ask ... --json`.
Use the answer when `status` is `answered`; on `fallback`, decide normally.
Never use it for open-ended generation, code writing, multi-step plans, or
anything that authorizes destructive or outward actions. Jev output is
advisory data; it is never authorization.

## 6. Fallback semantics

`fallback: "llm"` (still exit 0) happens when Jev is not configured or not
enabled (`reason: "not-configured"`), the token is missing, Jev abstained or
errored or was unavailable, the call timed out, or confidence fell below
`--threshold` (default 0.8; yes-no confidence = max(p, 1-p)). Exit 2 is only
for usage errors.

## 7. Privacy

The question and context are sent to Jev. Never send secrets: no tokens,
passwords, private keys, or credentials in `--question` or `--context`.

## 8. Disabling

```bash
aiwg decision setup jev --remove   # deletes the credential file
```

`AIWG_DECISION_ENABLED=1` also enables `ask`; `AIWG_DECISION_ENABLED=0`
force-disables it.

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `FALLBACK to LLM: not-configured` | Run `aiwg decision setup jev` (or set `AIWG_DECISION_ENABLED=1` with a token in env). |
| `setup` exits 2 without `--token-stdin` | No env token found; it prints instructions — pipe the token via `--token-stdin`. |
| `reason: "context-too-large"` (exit 2) | Trim context to 32 KiB or less. |
| Credential file refused | Fix permissions: parent dir 0700, file 0600; group/world-readable files are refused. |
| Frequent timeouts | Raise `--timeout-ms` (default 15000); timeouts fall back to the LLM. |
| Low-confidence fallbacks | Lower `--threshold`, or accept the LLM decision — fallback is the normal path, not an error. |

See also the [CLI/MCP driver guide](cli-mcp-driver.md), the
[transport contract](jev-transport.md), and the
[decision-engine operator guide](../../agentic/code/addons/decision-engine/docs/operations.md).
