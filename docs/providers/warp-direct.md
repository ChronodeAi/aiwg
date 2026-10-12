# Warp / Oz direct-worker profile (#2905)

This direct-worker profile renders `warp-terminal agent run` for Oz
`v0.2026.10.07.08.29.stable_00`. It remains **unqualified**: no
authenticated run has established the output envelope or execution location.
The evidenced host (`noodle`) has the APT executable `warp-terminal` and
no `oz` symlink.

## Evidence and rendered command

The captured real help is
`.aiwg/working/s1-scratch/cli-help/warp-0.2026.10.07.txt` in the main
checkout. Its `agent run --help` documents these exact lines:

- `--model <MODEL_ID>`: “Override the base model used by this command.”
- `-C, --cwd <CWD>`: “Working directory for the agent”.
- `--output-format <OUTPUT_FORMAT>`: `json`, `ndjson`, `pretty`, `text`.
- `--skill <SKILL>`: “Use a skill as the base prompt for the agent.”
- `--no-snapshot`: “Disable the end-of-run workspace snapshot upload”.

The adapter renders this template; the skill token contains the invocation
ID, never the brief:

```text
warp-terminal agent run --output-format json --model <MODEL_ID> \
  --cwd <workspace> --skill aiwg-brief-<invocationId> --no-snapshot
```

Historical no-model probes on 2026-10-11 established normal value-taking
arity for `--prompt` and `--skill` (a following flag produced “a value is
required”), and rejected `--output-format bogus`. A run with only
`-f <missing>.json --output-format json` reported the required group
`<--prompt|--saved-prompt|--task-id|--skill>` missing: the undocumented
configuration-file schema cannot be assumed to carry the brief. The
historical full template with `--skill aiwg-direct-brief` reached only:

```text
You are not logged in - please log in with `warp-terminal login` to continue.
```

The old fixed name is retained here solely as probe evidence. It is never
emitted by the adapter. No new real probes or model calls were made for
these fixes.

## Brief transport is NOT available today

`--prompt` puts text on argv and is never emitted. The intended transport
uses a generated skill file. `buildWarpBriefSkillName(invocationId)` maps
an invocation ID to `aiwg-brief-<invocationId>` without sanitizing,
normalizing or truncating it. IDs must contain 1–52 lowercase ASCII
letters, digits or hyphens, starting with a letter or digit; unsafe or
missing IDs are rejected. Names are at most 63 characters. Distinct IDs
produce distinct paths; the executor must supply a unique ID for each
invocation.

`buildWarpBriefSkillFile(brief, invocationId)` returns only
`{ relativePath, content }`, with the intended path
`.agents/skills/aiwg-brief-<invocationId>/SKILL.md`. Both it and
`buildWorkerArgs` stay pure: resolution writes no files.

Generating the skill file at execution time is **pending #3002**. The
execution owner must supply the invocation ID, **refuse to overwrite an
existing path**, clean up the generated file afterward, and **never commit
it**. The shared execution primitive is unavailable today.

Help lists `.agents/skills/`, `.warp/skills/`, `.claude/skills/`, and
`.codex/skills/` as search directories. The skill search root relative to
`--cwd` and the real CLI's behavior when a skill is missing are
**UNVERIFIED**: every real skill probe stopped at the login gate. The
fake's “skill not found” failure is a **fixture assumption**, not evidence
that the real CLI fails closed.

## Snapshot and execution controls

The cloud subcommand (`agent run-cloud`) and cloud flags
(`--environment`/`-e`, `--conversation`) are never emitted. Neither are
`--harness` or `--team`. Snapshot upload is disabled by the always-emitted
`--no-snapshot` flag. **Execution location is unverified until an
authenticated run**; these controls do not establish that nothing else is
uploaded.

The captured help names no reasoning-effort, sandbox, permission-mode or
approval flag for this run. These controls remain unavailable/unqualified.
Only the declared `external` sandbox contract is accepted by the adapter;
other sandbox requests are rejected. Any real dispatch requires an
external isolation boundary. Authentication uses an existing login or
`WARP_API_KEY` in the environment, never `--api-key` on argv.

## Final extraction refuses all output

No authenticated run has shown the Oz output envelope. Help documents a
JSON output format but no terminal marker or answer field; generic binary
`strings` hits do not establish that grammar. Schema-valid text therefore
cannot be trusted as a terminal answer. Like Copilot direct,
`parseOutput` **always returns null**, and `parseWorkerFinal` **always
throws `WorkerContractError` with `OG_CONTRACT_UNSUPPORTED`**, including
for MCP format. Claims-shaped documents, error objects, arrays and plain
text are all refused by both hooks. No candidate or validated final is
published on their strength.

The **intended parsing rule, not active code**, is to validate the observed
Oz envelope and affirmative terminal success, reject any error or trailing
content, extract only the last terminal assistant answer (never a tool
result or earlier turn), require non-empty answer text, then validate that
text against the shared `workerClaims` schema. A single well-formed JSON
object alone is insufficient. The actual envelope fields must first be
established by an authenticated run.

## Manual smoke run (blocked pending authentication and #3002)

Once authentication and execution-time generation are available, this
manual evidence probe uses a private directory, an invocation-specific
skill, exclusive creation and cleanup. It assumes the intended search root
only to investigate that still-unverified behavior:

```sh
(
  d=$(mktemp -d) || exit 1
  trap 'rm -rf -- "$d"' EXIT
  cd "$d" || exit 1
  invocation_id=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')
  skill="aiwg-brief-$invocation_id"
  mkdir -p .agents/skills
  mkdir ".agents/skills/$skill" || exit 1
  (set -C; printf -- '---\nname: %s\ndescription: smoke test\n---\n\nReply with exactly: warp-smoke-ok\n' "$skill" \
    > ".agents/skills/$skill/SKILL.md") || exit 1
  MODEL="<observed warp-terminal model list id>"
  warp-terminal agent run --output-format json --model "$MODEL" --cwd "$d" \
    --skill "$skill" --no-snapshot
  result=$?
  printf 'exit=%s\n' "$result"
  exit "$result"
)
```

A non-zero exit is a failure. Exit zero and valid JSON are evidence to
inspect, not an adapter success: record the raw envelope, actual answer
field, skill lookup and execution location before enabling extraction.
This probe never qualifies the registry profile by itself.
