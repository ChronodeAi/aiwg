# Codex direct-worker profile (B-OG-07, #2897)

This is the lightweight CLI profile for dispatching `codex` as a direct
worker (not the Ralph-loop session driver documented in
[`codex-sessions.md`](./codex-sessions.md), which covers transcript import).

The bundled `direct-shell` invocation profile in
`agentic/code/providers/model-capabilities.v1.json` is version-bound to
`codex-cli 0.161.0` and documentation/help-evidenced only
(`H:` evidence grade). It stays `unqualified` for dispatch until a human
qualifier reviews a live run. The adapter
(`tools/ralph-external/lib/codex-adapter.mjs`) renders:

```
codex --no-daemon exec --ignore-user-config -m <model> \
  -c model_reasoning_effort="<effort>" -s <sandbox> -C <workspace> \
  -c approval_policy="<approval>" --skip-git-repo-check \
  -o <final> --json - < <brief>
```

The brief always travels on stdin (the trailing `-` prompt argument); it
never appears in argv. Effort and approval travel only as `-c` config
overrides — there is no `--effort` flag, and `approval_policy` is restricted
to `"never"` (non-prompting execution only).

## Manual smoke run

The conductor runs this once, by hand, after `codex` is installed, to record
a pass/fail and the observed CLI version on the tracking issue. It is not
part of default CI and performs exactly one live, billable call.

```sh
mkdir -p /tmp/codex-smoke && cd /tmp/codex-smoke
echo 'Reply with exactly: codex-smoke-ok' | codex --no-daemon exec \
  --ignore-user-config -m gpt-6-luna -c model_reasoning_effort="low" \
  -s read-only -C "$PWD" -c approval_policy="never" \
  --skip-git-repo-check -o final.json --json - ; echo "exit=$?"
```

### Reading the result

- **Exit code**: `echo "exit=$?"` must print `exit=0`. Any non-zero exit is a
  fail, even if a final file was written.
- **`turn.completed` on stdout**: the `--json` stream is JSONL on stdout.
  Grep it for a terminal event: `codex ... --json - < prompt.txt | grep
  '"type":"turn.completed"'`. A run that exits 0 without a `turn.completed`
  (or that emits a standalone `"type":"error"` event anywhere in the stream)
  is a fail — a clean exit code alone is not sufficient.
- **`-o final.json`**: must exist and contain the final response text. An
  empty or truncated `final.json` alongside exit 0 is still a fail.

Record the installed `codex --version` output, the command above, and the
pass/fail outcome (exit code + `turn.completed` + `final.json` contents) on
the tracking issue. This manual run is evidence only; it never marks the
registry profile as qualified for automated dispatch.
