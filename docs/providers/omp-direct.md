# OMP direct-worker profile (B-OG-45, #2910)

This is the lightweight CLI profile for dispatching `omp` ("Oh My Pi") as a
direct worker (not the legacy Ralph-loop session driver's
`buildSessionArgs`, which still uses the same binary but a different,
pre-existing argument shape; also distinct from the RPC transport in
`tools/providers/omp-transport.mjs`, which this profile does not use).

The bundled `direct-shell` invocation profile in
`agentic/code/providers/model-capabilities.v1.json` is version-bound to
`omp/18.8.7` and documentation/help-evidenced only (`H:`/`R:` evidence
grades — see the adapter's header comment for the exact citations). It
stays `unqualified` for dispatch until a human qualifier reviews a live
run. The adapter (`tools/ralph-external/lib/omp-adapter.mjs`) renders:

```
omp --mode json --print --no-extensions --no-skills --no-rules \
  --model <model> --thinking <effort> --cwd <workspace> \
  --approval-mode write < <brief>
```

`--print` is kept explicit alongside `--mode json` because OMP's own
`--help` lists it as a separate flag. `--approval-mode` is **always**
rendered explicitly and never omitted: a static read of the installed omp
binary (`~/.local/bin/omp`, 18.8.7, noodle) shows the
compiled-in default when no flag is given is `"yolo"` — a full
sandbox/approval bypass — so omitting the flag would be the most dangerous
outcome, not a safe one. The same binary defines the mode's tool-tier gate
explicitly (`Kxa = {"always-ask": "read", write: "write", yolo: "exec"}`
against tiers `{read: 0, write: 1, exec: 2}`; a tool is auto-approved only
when its own tier rank is at or below the mode's threshold rank).
`write`'s threshold is `write` (rank 1): it auto-approves `read`- and
`write`-tier tools, but an `exec`-tier tool (**bash**, the dominant tool
for a coding worker) still resolves to a required-approval decision. No
headless auto-resolution for that decision was found in the binary. So
`write` is the least-prompting of the two non-bypass values (`always-ask`'s
threshold is `read`, rank 0, so it additionally prompts for `write`), but
it is **not** a complete non-prompting guarantee — bash calls under
`--approval-mode write` in print mode are an open gap, which is why the
`approval` control stays `unqualified` rather than claiming success. `yolo`
is never used. OMP has no `--approve/--no-approve` trust flag like Pi, so
the direct profile always disables workspace-local extension/skill/rule
discovery instead (`--no-extensions --no-skills --no-rules`). `--cwd` is
explicit (unlike Pi, which has no such flag). There is no `-o`/output-file,
`--output-schema` or step-cap flag; the final answer comes from the stdout
event stream (`agent_end` with `willContinue: false`), never a file. The
brief always travels on stdin — there is no positional prompt argument —
**confirmed** by a static read of the installed omp binary (not merely
inherited from Pi's lineage): OMP's own `readPipedInput` drains non-TTY
stdin to EOF whenever mode is not `rpc`/`rpc-ui`/`acp` (`--mode json`
included), and its result feeds OMP's own `buildInitialMessage` the same
way Pi's does. Unlike Pi, OMP does not trim the piped text it returns.

## Manual smoke run

The conductor runs this once, by hand, after `omp` is installed, to record
a pass/fail and the observed CLI version on the tracking issue. It is not
part of default CI and performs exactly one live, billable call.

```sh
mkdir -p /tmp/omp-smoke && cd /tmp/omp-smoke
echo 'Reply with exactly: omp-smoke-ok' | omp --mode json --print \
  --no-extensions --no-skills --no-rules --model <provider/model> \
  --thinking low --cwd "$PWD" --approval-mode write ; echo "exit=$?"
```

### Reading the result

- **Exit code**: `echo "exit=$?"` must print `exit=0`. Any non-zero exit is
  a fail.
- **`agent_end` with `willContinue:false` on stdout**: the `--mode json`
  stream is JSONL on stdout, one event per line. Grep it for the terminal
  event: `omp ... | grep '"type":"agent_end"'` and confirm the same line
  reports `"willContinue":false`. A run that exits 0 without that terminal
  event is a fail.
- **Reply text**: the terminal `agent_end` event should carry an assistant
  message whose text is `omp-smoke-ok`. A clean terminal with no assistant
  message, or a different reply, is a fail.
- **Confirm the stdin-as-prompt behavior**: stdin-to-prompt is confirmed by
  static code read (not merely inherited), but if the reply text is empty
  or the run hangs waiting for more input on the live binary, record that
  finding on the tracking issue — it refutes the static-read evidence and
  blocks dispatch until the profile is revised.
- **Watch for a bash call stalling or erroring**: `--approval-mode write`
  auto-approves read/write-tier tools only; if the smoke prompt ever
  provokes a bash/exec-tier tool call, record whether the run hangs,
  errors or otherwise fails to complete — this is the profile's known open
  gap (see the adapter header comment), not a new finding.

Record the installed `omp --version` output, the command above, and the
pass/fail outcome (exit code + terminal event + reply text) on the tracking
issue. This manual run is evidence only; it never marks the registry
profile as qualified for automated dispatch.
