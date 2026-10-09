# Hermes direct-worker profile (B-OG-48, #2912)

This is the lightweight CLI profile for dispatching `hermes` as a direct
worker (not the session-import tooling documented in
[`hermes-sessions.md`](./hermes-sessions.md)).

The bundled `direct-shell` invocation profile in
`agentic/code/providers/model-capabilities.v1.json` is version-observed
against the installed `hermes 0.20.6` `hermes chat --help` and the installed
`hermes_cli` source (`H:`/`D:` evidence grades). It stays `unqualified` for
dispatch until a human qualifier reviews a live run. The adapter
(`tools/ralph-external/lib/hermes-adapter.mjs`) renders:

```
hermes chat --query-file - --oneshot --quiet --ignore-user-config --ignore-rules --source tool -m <model> --reasoning <effort>
```

with the brief piped on stdin (never argv).

## Why `chat --query-file - --oneshot --quiet`, not the top-level `-z`

Reading the installed source (never running it) rules `-z` out as the
baseline for a restricted task: it is argv-only for the brief
(`hermes_cli/_parser.py:153-162`) and `hermes_cli/oneshot.py` unconditionally
sets `HERMES_YOLO_MODE=1`/`HERMES_ACCEPT_HOOKS` (docstring + line 255-256)
with no disabling flag at all.

`chat --query-file - --oneshot --quiet` reads the brief from stdin to EOF
(`hermes_cli/main.py:3443-3454`) and the quiet branch's exit code is `1 if
result.get("failed") else 0` (`cli.py:22209-22223`) — a turn that printed
partial text before failing still exits 1 (unlike `-z`).

## Exit 0 is NOT completion evidence

Two distinct, source-confirmed cases make exit 0 insufficient by itself,
even on `chat --quiet`:

- Partial text printed before `failed` — this one `chat` handles correctly
  (exits 1; see above).
- **Reasoning-budget exhaustion is not caught by the exit code at all.**
  `agent/conversation_loop.py:3902` returns `{"final_response": "⚠️
  **Thinking Budget Exhausted**...", "completed": False, "partial": True,
  "error": "..."}` with **no `"failed"` key** (not `false` — absent). The
  non-empty warning text still prints to stdout, and because
  `result.get("failed")` is `None` (falsy), `cli.py`'s `_exit_code` stays
  `0`. **Exit 0, non-empty stdout, genuinely incomplete.**

For this reason, `HermesAdapter.parseWorkerFinal` does not stop at the
exit-derived status: it also requires the final text to parse as a strict
`workerClaims` JSON document (#2890,
`ProviderAdapter.parseWorkerFinal`/`parseWorkerOutput`, `format: 'json'`).
A warning message, an error string, or any other free text fails that
parse regardless of exit code — this is the case the top-level `-z` path
has no equivalent defense against at all.

## Approval policy: not emitted-flag-only, and NOT just `--yolo`

Approval policy is **host config** (`~/.hermes/config.yaml`), not a single
argv flag, and `--yolo` is one of several bypasses, not the only one:

- `approvals.single_query_mode` (`tools/approval.py:3552`,
  `_get_single_query_approval_mode()`) accepts `approve/off/allow/yes` as
  config values, treated as auto-approve (logged at `approval.py:3856`). The
  built-in default is `"deny"` (`hermes_cli/config_defaults.py:2559`), but a
  host's `config.yaml` can override it to `approve`.
- `approvals.mode` (default `"smart"`, `config_defaults.py:2519`) can be set
  to `"off"` in config.yaml, bypassing approval prompts the same way
  `--yolo` does (`tools/approval.py:4778,5475`).
- `HERMES_YOLO_MODE` is a process env var frozen at Python import
  (`tools/approval.py:37`) — if present in the worker's environment, every
  approval gate auto-approves unconditionally, with no argv involved at all.

This adapter always emits `--ignore-user-config` (verified on `hermes chat
--help`), which makes the session fall back to the **safe built-in
defaults** (`single_query_mode: deny`, `approvals.mode: smart`, never
`off`) regardless of the host's `config.yaml` — session/auth credentials
still resolve via `.env`, so this never blocks dispatch. `HERMES_YOLO_MODE`
(and any other `HERMES_*` override) is defeated structurally, not by a
flag: the bundled profile's `envAllowlist` is `[]` and the shared shell
renderer clears the child environment (`env -i <allowlist-only>`), so an
ambient `HERMES_YOLO_MODE` in the conductor's own environment can never
reach the child — proven by an explicit assertion
(`hermes-direct.test.ts` HD10). The `approval` control still stays
`unqualified` on the bundled registry: `--ignore-user-config`'s effect is
real and source-evidenced, but it is not live-qualified.

There is no `--usage-file`/JSON-report equivalent for `chat`: that flag is
read only at the top-level `-z`/`--oneshot PROMPT` dispatch sites
(`hermes_cli/main.py:12729,12787,14784`). Final-output extraction for this
profile is stdout text on exit 0 PLUS the strict workerClaims parse above,
never exit code or stdout non-emptiness alone.

## Manual smoke run

The conductor runs this once, by hand, after `hermes` is installed, to
record a pass/fail and the observed CLI version on the tracking issue. It is
not part of default CI and performs exactly one live, billable call.

```sh
echo 'Reply with exactly: hermes-smoke-ok' | hermes chat --query-file - \
  --oneshot --quiet --ignore-user-config --ignore-rules --source tool -m anthropic/claude-sonnet-4.6 \
  --reasoning low ; echo "exit=$?"
```

### Reading the result

- **Exit code**: `echo "exit=$?"` must print `exit=0`. Any non-zero exit is
  a fail, even if some text was printed to stdout.
- **stdout**: must contain exactly `hermes-smoke-ok` (plus a trailing
  newline) and nothing else — no banner, spinner, or session line (the
  session ID line goes to stderr). A non-empty but different message (e.g.
  a budget-exhaustion warning) is still a fail even though it exits 0 — see
  "Exit 0 is NOT completion evidence" above.

Record the installed `hermes --version` output, the command above, and the
pass/fail outcome (exit code + stdout text) on the tracking issue. This
manual run is evidence only; it never marks the registry profile as
qualified for automated dispatch.

## Isolation and caps (`hermes chat --help`, v0.20.6)

- `--ignore-rules`: "Skip auto-injection of AGENTS.md, SOUL.md, .cursorrules, memory, and preloaded skills. Combine with --ignore-user-config for a fully isolated run." It is always emitted with `--ignore-user-config`, so a worker never loads repository rules or user memory into its brief.
- `--source tool`: session source tag. Help: "Use 'tool' for third-party integrations". It keeps worker sessions apart from the user's own sessions.
- `--max-turns N`: "Maximum tool-calling iterations per conversation turn (default: 500, or agent.max_turns in config)". This is the evidenced step-cap mapping. The step-cap control stays `unqualified` until it is wired to an invocation-selected limit.
- `--run-budget SECONDS`: an optional wall-clock budget per run. It is complementary to the conductor's own timeout.
