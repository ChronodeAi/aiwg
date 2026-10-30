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

## Brief delivery is wired; vendor discovery remains unverified

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

`buildWorkerArtifacts` now declares that file for the shared session launcher.
Resolution supplies one invocation ID, which binds both the `--skill` token
and the workspace path. Revalidation checks the entire saved plan against its
conductor-owned persisted copy. The plan must be outside cwd and every
qualified worker-writable root (including symlink aliases); a JSON object alone
cannot authenticate its invocation ID. The installed loader rechecks the
declaration against the approved adapter; resolution remains pure. At execution time the launcher
allows one workspace-relative file under the fixed adapter-owned prefix,
rejects absolute, traversal, non-normalized and mismatched invocation paths,
and opens every path component without following symlinks. Creation uses
`O_EXCL`: collisions are reported and the existing file is preserved.
Content is limited to 1 MiB of UTF-8 bytes. Materialization completes before the
worker process starts. Concurrent hostile writers at that stage are leftover
processes or other tenants of the same tree. Cleanup requires launcher-owned
stop proof; uncertain termination retains the artifacts and reports
`artifactCleanup: { status: 'retained', reason: 'stop-proof-uncertain' }` in the
result and exit record. A direct child's exit in degraded mode does not prove
that its descendants stopped.

Directory creation uses Node alone on Linux and macOS. The launcher exclusively
`mkdir`s the invocation-specific `aiwg-brief-<invocation-id>` directory in a
verified parent, takes an initial `lstat`, opens it with
`O_NOFOLLOW | O_DIRECTORY`, and checks that it is empty. It compares the opened
descriptor's device/inode with the initial observation and an `lstat` reached by
re-walking the parent chain from cwd. Only after those checks is the directory
recorded as owned. EEXIST fails closed without adopting or deleting any existing
entry, including an empty directory. Any observed substitution or unprovable
identity fails closed; an unproven directory is retained without deletion.
Missing shared prefixes such as `.agents` and `.agents/skills` use the same
creation checks. Existing prefixes are checked without being adopted; shared
prefixes are always left in place, including empty ones.

After exclusive file creation, and again after writing, the launcher reopens the
full declared path from `/` through cwd with per-component `O_NOFOLLOW`, checking
every directory and the file against the recorded device/inode chain. A mismatch
fails the launch before spawning a worker. When stop proof permits cleanup, it
first atomically renames each leaf and owned directory into a private 0700
quarantine under the run directory on the same filesystem, then checks its
device/inode there. Only matching entries are deleted. Replacements and nonempty
directories remain in quarantine and are reported with its path. Linux uses
pinned directory descriptor paths; other POSIX hosts use checked pathnames and
retain entries if a relocated parent's identity cannot be recovered. Generated
skills must never be committed.

**Residual race windows:** Node has neither an atomic beneath-root creation
operation nor a mkdir operation returning an opened descriptor. These checks
compare observed identities; they cannot prove that an empty directory was not
substituted between mkdir and the first identity observation. Re-walking is also
sequential: a directory can move after its component was checked or after final
verification. A concurrent writer can relocate a parent just before creation or
during writing, so an empty directory, empty file, or brief bytes can transiently
exist outside cwd. The reproduced relocations are detected and the owned leaf is
reverted by quarantine cleanup on Linux; unproven directories and entries whose
parents cannot be recovered are retained and reported. Transient creation is
detected and reverted where identity is established, not prevented. These checks
do not prove continuous containment against an unrestricted concurrent renamer;
a filesystem boundary preventing ancestor renames or native atomic primitives
would be needed for that stronger guarantee.

This extends #3021's run-directory artifacts. Delivery is covered by offline
launcher and installed-adapter fixtures, including reading the generated skill;
it does not qualify the real CLI's skill lookup or output grammar.

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

## Manual smoke run (blocked pending authentication)

Once authenticated access is available, this
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

Remaining provider work is an operator capture of authenticated success and
error envelopes, followed by evidence-backed terminal-answer extraction and a
manual smoke result with the CLI version. Confirm skill lookup relative to cwd,
missing-skill behavior and execution location during that run. Until then the
registry profile stays unqualified and final extraction stays unsupported.
