# Pi direct-worker profile (B-OG-45, #2910)

This is the lightweight CLI profile for dispatching `pi` as a direct worker
(not the legacy Ralph-loop session driver's `buildSessionArgs`, which still
uses the same binary but a different, pre-existing argument shape).

The bundled `direct-shell` invocation profile in
`agentic/code/providers/model-capabilities.v1.json` is version-bound to
`pi 0.87.1` and documentation/help-evidenced only (`H:`/`R:` evidence
grades — see the adapter's header comment for the exact citations,
including a static read of the installed CLI's own bundle for the
stdin-as-prompt behavior). It stays `unqualified` for dispatch until a
human qualifier reviews a live run. The adapter
(`tools/ralph-external/lib/pi-adapter.mjs`) renders:

```
pi --mode json --no-approve --no-context-files --no-extensions --no-skills \
  --model <model> --thinking <effort> < <brief>
```

`--mode json` forces non-interactive JSONL output on its own (no `--print`
needed). `--no-approve` is fixed — the direct profile never emits
`--approve`, which would trust arbitrary project-local extension/config
files — but `--no-approve` alone does **not** stop context loading: a
static read of the installed pi 0.87.1 bundle (`chunk-OJP47DM6.js:1251`)
shows ancestor `AGENTS.md`/`CLAUDE.md` load independently of trust unless
`--no-context-files` is also set. `--no-extensions` and `--no-skills`
disable the same two untrusted-workspace-file discovery surfaces OMP's
profile already disabled. There is no `-C/--cwd`, `-o`/output-file, `--output-schema` or
step-cap flag; the workspace binds through the launcher's own `cd`, and the
final answer comes from the stdout JSONL stream (`agent_end`/
`agent_settled`), never a file. The brief always travels on stdin — there is
no positional prompt argument — because Pi's own `readPipedStdin()` reads
piped, non-TTY stdin and uses it as the sole initial message when no
positional message/file argument is given.

## Manual smoke run

The conductor runs this once, by hand, after `pi` is installed, to record a
pass/fail and the observed CLI version on the tracking issue. It is not part
of default CI and performs exactly one live, billable call.

```sh
mkdir -p /tmp/pi-smoke && cd /tmp/pi-smoke
echo 'Reply with exactly: pi-smoke-ok' | pi --mode json --no-approve \
  --no-context-files --no-extensions --no-skills \
  --model <provider/model> --thinking low ; echo "exit=$?"
```

### Reading the result

- **Exit code**: `echo "exit=$?"` must print `exit=0`. Any non-zero exit is
  a fail.
- **`agent_settled` on stdout**: the `--mode json` stream is JSONL on
  stdout, one event per line. Grep it for the terminal event: `pi ... |
  grep '"type":"agent_settled"'`. A run that exits 0 without an
  `agent_settled` event is a fail, even if earlier `agent_end` events look
  healthy.
- **Reply text**: the `agent_end` event immediately before `agent_settled`
  should carry an assistant message whose text is `pi-smoke-ok`. A settled
  stream with no assistant message, or a different reply, is a fail.

Record the installed `pi --version` output, the command above, and the
pass/fail outcome (exit code + `agent_settled` + reply text) on the tracking
issue. This manual run is evidence only; it never marks the registry
profile as qualified for automated dispatch.
