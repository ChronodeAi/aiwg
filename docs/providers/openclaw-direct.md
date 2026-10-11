# OpenClaw direct-worker profile (#2907)

This is the lightweight CLI profile for dispatching `openclaw` as a direct
worker. The bundled `direct-shell` invocation profile in
`agentic/code/providers/model-capabilities.v1.json` is version-bound to
`openclaw 2026.10.1` and evidenced from an installed binary's
`--help`/`agent exec --help` (`H:` grade) plus the installed npm package's
own bundled source for the two behaviours no flag documents (`R:` grade). It
stays `unqualified` for dispatch until a human qualifier reviews a live run.

## No CLI sandbox — an external boundary is required

**This profile has no CLI-enforced sandbox and no CLI-enforced read-only
mode.** `--isolated` source-confirms `agents.defaults.sandbox.mode: "off"`
and `tools.exec.mode: "full"`: the embedded agent can run arbitrary shell
commands. `tools.fs.workspaceOnly: true` bounds file *tools* to `--cwd`, but
that does not bound command *execution* — a shell command inside the
workspace is not confined to it. The registry advertises
`sandboxModes: ["external"]` only (never `read-only`/`workspace-write`): a
caller requesting either of those for this profile is refused before any
argv is rendered. Dispatching this profile for real work requires an
**external** boundary — host/executor-level isolation (container, worktree
plus OS-level confinement, disposable VM) owned by the conductor, not by
`openclaw` — and that includes the smoke command below: run it only inside
such a boundary (the conductor's smoke run used a throwaway directory on an
isolated worker host and a prompt that asks for no tool use).

The adapter (`tools/ralph-external/lib/openclaw-adapter.mjs`) renders:

```
openclaw agent exec --isolated --auth-env-only --json \
  --model <provider/model> --thinking <level> --cwd <workspace> \
  --message-file <briefPath>
```

`agent exec` ("Run one isolated headless embedded agent turn") is the
no-gateway, no-channel entrypoint — distinct from `openclaw agent`, which
routes through the Gateway and can `--deliver` a reply to a chat channel.
`--deliver` and every routing flag (`--to`, `--channel`, `--reply-*`) are
never emitted. The brief always travels as a file path
(`--message-file <path>`); it never appears on argv as text, and no
`--fallback` is ever emitted. `--message-file` also accepts `-` for stdin
per `agent exec --help`; this profile keeps the file-path transport (it
works with the existing renderer today) and documents stdin as available,
not used.

`--isolated` ignores the ambient config entirely and skips plugin/MCP
install roots outright — the disabling control the no-auto-approval
invariant calls for. `--auth-env-only` forces credential resolution from
environment variables only. Neither sandbox nor approval has its own flag on
`agent exec --help`; source reading on the installed package confirms an
isolated run binds `agents.defaults.sandbox.mode: "off"`,
`tools.exec.mode: "full"`, `tools.fs.workspaceOnly: true`,
`env.shellEnv.enabled: false` (see the boundary warning above — this is
full command execution with no CLI sandbox, not a confinement to `--cwd`).
This is reported as `sandbox`/`approval`: `unavailable`, not invented as a
flag.

`--json` prints exactly one envelope object on stdout once the run settles:
`{ ok, status, final, payloads, model, provider, sessionId, error? }` (no
JSONL stream, no `-o` file). The live smoke run below confirmed this is
printed pretty-printed (multi-line) JSON. Exit code mirrors `status`
(`ok` → 0, `timeout` → 2, else → 1), but neither `parseOutput()` (the
candidate extractor) nor `parseWorkerFinal()` (the authoritative gate, which
hands the envelope's `final` text to the shared strict `workerClaims`
parser) trusts the exit code alone: both independently require
`ok === true`, `status === "ok"` and a non-empty `final` before accepting
anything, and both reject any unsuccessful envelope outright rather than
returning it as a candidate.

`--thinking` accepts `off|minimal|low|medium|high|xhigh|adaptive|max|ultra`;
`adaptive` (OpenClaw picks the level itself) is excluded as a "let the tool
choose" value, the same way `auto`/`default` model values are refused.

## Manual smoke run

The conductor runs this once, by hand, after `openclaw` is installed, to
record a pass/fail and the observed CLI version on the tracking issue. It is
not part of default CI and performs exactly one live, billable call through
OpenRouter (`OPENROUTER_API_KEY` must be in the environment — the only
allowlisted env var name for this profile).

```sh
d=$(mktemp -d) && cd "$d"
echo 'Reply with exactly: openclaw-smoke-ok' > brief.md
MODEL="openrouter/openai/gpt-5-mini"
openclaw agent exec --isolated --auth-env-only --json \
  --model "$MODEL" --thinking low --cwd "$d" --message-file brief.md \
  ; echo "exit=$?"
```

### Reading the result

- **Exit code**: `echo "exit=$?"` must print `exit=0`. A non-zero exit is a
  fail.
- **The stdout envelope**: pipe the run through `jq .` — it must be exactly
  one JSON object with `"ok":true`, `"status":"ok"`, and a non-empty
  `"final"` field. An envelope with `"ok":false` (even alongside exit 0, if
  that is ever observed) is a fail, and so is an empty `"final"`.
- There is no separate output file to check: the envelope above is the
  entire final output.

Record the installed `openclaw --version` output, the command above, and
the pass/fail outcome (exit code + envelope contents) on the tracking
issue. This manual run is evidence only; it never marks the registry
profile as qualified for automated dispatch.
