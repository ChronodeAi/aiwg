# GitHub Copilot CLI direct-worker profile (B-OG-36, #2901)

This is the lightweight CLI profile for dispatching `copilot` (GitHub
Copilot CLI) as a direct worker.

The bundled `direct-shell` invocation profile in
`agentic/code/providers/model-capabilities.v1.json` is version-bound to
`copilot 1.0.95` and help-evidenced only (`H:` evidence grade, captured from
`copilot --help` and `copilot help sandbox|permissions|config|environment`
on host `noodle`, 2026-10-10;
`.aiwg/working/s1-scratch/cli-help/copilot-1.0.95.txt`). It stays
`unqualified` for dispatch until a human qualifier reviews a live run. The
adapter (`tools/ralph-external/lib/copilot-adapter.mjs`) renders:

```
copilot -p "Follow the instructions in the attached file exactly." \
  --attachment <briefPath> --model <model> --reasoning-effort <effort> \
  -C <workspace> --output-format json --no-ask-user \
  --no-custom-instructions --disable-builtin-mcps \
  [--allow-tool <pattern> ...] [--deny-tool <pattern> ...]
```

**The brief rides on `--attachment`, never argv text or stdin.**
`-p/--prompt <text>` only accepts inline argv text ("Execute a prompt in
non-interactive mode") — there is no `--prompt-file` flag and no documented
stdin path for the main prompt. This profile fixes `-p` to a short,
content-free instruction and attaches the real brief as a file via
`--attachment <path>` ("Attach a file (image or native document) to the
initial prompt; only valid in non-interactive mode"), mirroring the
OpenCode `-f`/`--file` attached-file pattern. **An attachment only proves
the file reached the process; it does not prove the model treats its
contents as instructions the way stdin or a prompt would** — that is what
the manual smoke run below checks.

**Tool-approval prompts and the `ask_user` tool are two separate
non-interactive controls.** `--no-ask-user` disables the agent's own
`ask_user` tool. Separately, `--help` states `--allow-all-tools` is
"required for non-interactive mode" — but per this issue's implementation
notes, this profile never emits `--allow-all-tools`/`--allow-all`/`--yolo`.
It only emits scoped `--allow-tool`/`--deny-tool` tokens from the resolved
permission tuple. **Whether a tool outside that scoped allow-list fails
closed or blocks indefinitely in a non-interactive run is not evidenced
from `--help` alone** and stays unqualified pending a live run.

**No per-call OS sandbox flag is safely evidenced.** Root `copilot --help`
lists no `--sandbox` flag in its Options — only `copilot help sandbox`
prose mentions one, and enabling it needs host prerequisites (`bwrap`,
`slirp4netns`, `iptables`, `nf_tables` on Linux) this profile does not
probe. It is never emitted (and `--allow-all-paths` is never emitted
either); the profile relies on the CLI's own default path restriction
(cwd, PATH directories, the temp directory, the user profile).
`capabilities.sandboxModes` is therefore `["external"]`.

**The CLI's own JSONL event vocabulary is not documented, and there is no
readable source to fall back to.** `--output-format json` is "JSONL, one
JSON object per line" per `--help`, but no field names are documented
anywhere in `--help`. Unlike some other CLIs in this effort (e.g. Pi, whose
bundled JS chunks are readable), the installed `@github/copilot` package is
a ~180 MB compiled, per-architecture native binary — there is no bundled
JS to read statically, and a live/prompted run is out of scope for this
profile's qualification. `observeHealthEvent` therefore always returns
`null` (same pattern as `openhuman-adapter.mjs`/`factory-adapter.mjs` for
CLIs with no evidenced event grammar), and `parseOutput` enforces only the
one evidenced contract: every non-empty stdout line must be a JSON object.
Completion is exit-code gated only.

## Manual smoke run — currently BLOCKED on authentication

**Live evidence from the conductor (host `noodle`, `copilot` 1.0.95,
2026-10-10): a `COPILOT_GITHUB_TOKEN` holding a classic `ghp_` personal
access token exits 1 with stderr `Classic Personal Access Tokens (ghp_) are
not supported by Copilot` and EMPTY stdout.** A fine-grained PAT with
Copilot access, or a prior `copilot login`/`gh auth login`, is required
before this smoke run can proceed. As of this writing the smoke run is
blocked on obtaining supported credentials, so the real `--output-format
json` event stream remains unobserved — every control in this profile's
registry entry stays `unqualified` for exactly that reason.

The conductor runs the command below once, by hand, after `copilot` is
installed and logged in with a supported credential, to record a pass/fail
and the observed CLI version on the tracking issue. It is not part of
default CI. GitHub Copilot CLI uses GitHub-account models — there is no
OpenRouter key to inject, and the run depends entirely on the host's
existing `copilot` login state (never put a token on argv; auth is detected
from the CLI's own stored session, `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/
`GITHUB_TOKEN`, or `copilot login`).

```sh
MODEL="<exact observed model id>"   # e.g. from `copilot --model` examples; never 'auto'
d=$(mktemp -d) && cd "$d"
echo 'Reply with exactly: copilot-smoke-ok' > brief.md
copilot -p 'Follow the instructions in the attached file exactly.' \
  --attachment brief.md --model "$MODEL" --reasoning-effort low \
  -C "$d" --output-format json --no-ask-user --no-custom-instructions \
  --disable-builtin-mcps --allow-tool 'write' </dev/null
echo "exit=$?"
```

`</dev/null` is deliberate: stdin is never used by this profile, so closing
it removes any chance of waiting on a terminal that will never answer.
`--allow-tool 'write'` is included so that IF the agent invokes a
file-write tool, it does not block on a tool-approval prompt — it is not
evidenced from `--help` that any tool permission is required just to emit
a text response at all; widen the pattern only if the smoke prompt needs
another tool kind.

### Reading the result

- **Exit code**: `echo "exit=$?"` must print `exit=0`. Any non-zero exit is
  a fail.
- **Every stdout line is a JSON object, and no line is error-shaped**:
  `--output-format json` promises "JSONL, one JSON object per line." Check
  framing properly — parse each line on its own (a line-count comparison is
  not enough: `{} {}` on one line still splits into parseable values):
  ```sh
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    printf '%s' "$line" | jq -e -s 'length == 1 and (.[0] | type == "object" and .type != "error" and (.error == null))' >/dev/null \
      || { echo "FAIL: not one clean JSON object per line"; break; }
  done < out.jsonl
  ```
  Any line that fails to parse, parses to something other than a JSON
  object, has a top-level `type: "error"`, or carries a non-null top-level
  `error` field, is a fail (the adapter's `parseOutput` already rejects all
  of these — see `tools/ralph-external/lib/copilot-adapter.mjs`). No other
  specific field name is required or checked; the event vocabulary itself
  is unqualified.
- **No hang on a tool-approval prompt**: the run must exit on its own
  within a short bound. A process that keeps running past the prompt's
  expected completion window is a fail — it most likely means a tool
  outside `--allow-tool`'s scope needed approval that non-interactive mode
  could not grant.
- **Reply content**: read the stdout JSON for the literal reply
  `copilot-smoke-ok` (field name TBD from this run — record whichever key
  held it). Record on the issue to seed the real field name for a future,
  authorized qualification pass.

Record the installed `copilot --version` output, the command above, and
the pass/fail outcome (exit code + JSONL validity + no error-shaped lines +
reply content) on the tracking issue. This manual run is evidence only; it
never marks the registry profile as qualified for automated dispatch.
