# Guided Setup Interview (slice A3)

Progressive interview that extends `aiwg init` / `aiwg setup` in place.
The wizard lives in `src/cli/handlers/init.ts`; strict headless flag
parsing and the single interactive decision stay there. A3 records answers
and builds a versioned plan. It writes no config, credentials, or registry
entries — that is A4.

## 0. Non-goals and inputs

- A3 reuses A1 discovery output (`src/discovery/index.ts:46-58`) as read-only
  defaults and evidence. It never walks, probes, or executes tools itself.
- Discovery default is current workspace plus registry seeds
  (`src/discovery/index.ts:319-341`); bounded recursive scan runs only for
  explicit `roots` opt-in and refuses home/filesystem roots
  (`src/discovery/index.ts:342-351`). The interview must offer "scan more
  directories" only as an explicit opt-in question, never by default.
- Tool readiness in A3 is presence-only from `ToolInventoryEntry`
  (`src/discovery/types.ts:4-14`): `installed` from PATH
  (`src/discovery/index.ts:353-380`), plus `configured`/`authenticated`/
  `qualified` from prior local evidence only. No probes in A3.
- Plan shape, redaction gate, atomic store, resume helpers, and revalidation
  are A2 and reused unchanged: `src/discovery/plan-types.ts`,
  `src/discovery/plan-validation.ts`, `src/discovery/plan-store.ts`.

## 1. Question-ID convention

Format: `<block>.<topic>[.<scope>]`, all lowercase kebab-case.

- Charset: `a-z`, `0-9`, `.`, `-`. Segments separated by single dots.
  No spaces, slashes, or uppercase. (Question IDs are free-form `text` in
  `src/discovery/plan-validation.ts:46-51`; this convention is stricter so
  IDs survive shell, JSON, and log grep.)
- `<block>` is one of `targets`, `intent`, `tools`, `locations`,
  `capabilities`.
- `<scope>` qualifies the question by workspace and provider whenever the
  answer can differ per workspace or provider:
  `ws-<workspaceslug>.<provider-or-shared>`. Omit `<scope>` only for
  genuinely global questions (install method, scan opt-in, usage intent).
- `workspaceslug` is deterministic: `basename(root)` slugified
  (non-`[a-z0-9]` → `-`, trimmed) plus `-` plus the first 8 hex chars of
  SHA-256 over the canonical root (`realpath` form, as discovery
  canonicalizes in `src/discovery/index.ts:258-270`). Example: root
  `/home/u/shop` → `shop-9f2c4a1b`. Indexes are forbidden: insertion order
  is not stable across runs.
- Provider qualifier is the canonical provider definition id (e.g. `claude`,
  `codex`) or `shared` for provider-independent topics (scope, paths).

Examples (one per block):

- `targets.scope.shared` — project vs user scope for this workspace.
- `targets.root.ws-shop-9f2c4a1b.shared` — monorepo root-vs-package choice.
- `intent.use.ws-shop-9f2c4a1b.shared` — usage intent for this workspace.
- `tools.worker-dispatch.ws-shop-9f2c4a1b.shared` — worker-dispatch offer.
- `tools.provider.ws-shop-9f2c4a1b.codex` — select Codex for this workspace.
- `locations.config-dir.ws-shop-9f2c4a1b.codex` — where Codex config lives.
- `locations.credential-source.ws-shop-9f2c4a1b.codex` — credential locator.
- `capabilities.signing.ws-shop-9f2c4a1b.shared` — optional signed commits.

Inventory item IDs: A1 emits no IDs; projects are keyed by canonical `root`
and tools by `executable` (`src/discovery/types.ts:22-33`, `:4-14`). A3
derives every reference deterministically from that output:

- `inventoryId`: `inv-` + first 16 hex chars of SHA-256 over
  `JSON.stringify({projects: sortedRoots, tools: sortedExecutables, limits})`.
  Stable for identical inputs; changes when the observed set changes.
- Action `id`: `<provider>-<kind>-<workspaceslug>` (e.g.
  `codex-configure-provider-shop-9f2c4a1b`), plus `-2`, `-3` on collision.
  Rationale: human-greppable, stable across resume, unique per plan as
  required by `src/discovery/plan-validation.ts:112-113`.

## 2. Answer merge precedence

Order, highest first: `explicit-flag` > `existing-setting` > `interview` >
`discovered` > `default`. This matches the `AnswerSource` union in
`src/discovery/plan-types.ts:5` and the existing init behavior where a
supplied flag skips its prompt (`src/cli/handlers/init.ts:373-377`) and
setup's "supplied value is never re-asked" rule
(`src/cli/handlers/setup.ts:514-517`).

- `explicit-flag` always wins, with or without a terminal — same as
  `--worker-dispatch` overriding the presence gate today
  (`src/cli/handlers/init.ts:278-282`).
- An existing setting (value already in `.aiwg/aiwg.config`) is recorded
  with source `existing-setting` and is never overwritten by interview,
  discovered, or default values. Re-ask only when the user explicitly
  re-enters that question via back/edit navigation (§5) or reruns with
  `--force` (init's existing recreate path,
  `src/cli/handlers/init.ts:303-304`).
- `discovered` values seed `recommendations[]` (`reason` cites the
  observation, e.g. "PATH contains codex"), never `answers`. Promoting a
  recommendation to an answer requires explicit-flag or interview
  confirmation.
- Answered means present: any own property in `answers` counts, including
  `false`, `null`, and default-valued answers. This is exactly
  `unansweredPlanChoices` in `src/discovery/plan-store.ts:93-96`. A3 must
  test presence with `Object.hasOwn`, never truthiness — the store's resume
  test pins `false`/`null` as answered
  (`test/unit/discovery/plan-store.test.ts:187-207`).

## 3. Credential questions

- Credential questions offer exactly three answers: `env` (name the
  variable), `file` (absolute path), `stdin-at-apply` (prompt at apply
  time). The recorded value is always a `CredentialReference`
  (`src/discovery/plan-types.ts:8-12`); raw strings, pasted tokens, and
  key material are never recorded.
- No raw credential default is ever offered or displayed. Defaults for
  credential questions are `null` (unanswered), and `recommendations[]`
  must not carry secret-looking values — the store scans recommendations,
  choice options/defaults, keys, and evidence and rejects them
  (`src/discovery/plan-validation.ts:64-104`,
  `test/unit/discovery/plan-store.test.ts:163-175`).
- Skip leaves the question unanswered (kept in `unansweredPlanChoices`).
  Defer also leaves it unanswered and sets `deferredAt` on its
  `UnresolvedChoice`; the next session asks deferred questions first. Both
  still permit `writeSetupPlan`: the plan persists with the choice
  unresolved, and the corresponding action stays gated until A4.
- Presentation: one line naming the consumer (provider + purpose), the
  three source options with the conventional env name shown as a *name
  suggestion* (not a value), and an explicit `[skip]`/`[defer]` affordance.

## 4. The five question blocks

Each question lists: one-line explanation, default, headless flag.

### (a) Targets and scope

- `targets.scope.shared` — "Project writes `.aiwg/` here; user writes your
  global provider config." Default `project`. Flag: **new**
  `--scope project|user` on `init`/`setup` (no scope flag exists today;
  existing `--target <dir>` in `src/cli/handlers/setup.ts:606` selects the
  directory, not the scope).
- `targets.workspaces.<scope>` — "Which observed roots get configured?"
  Multi-select over `inventory.projects[].root`. Default: workspace root
  only. Flag: **new** `--workspace <root>` (repeatable) on `setup`.
- `targets.root.<scope>` — "Monorepo: configure the root once, or one
  package?" Asked whenever `layout` is `monorepo` or `ambiguous`
  (`src/discovery/types.ts:22-33`, ambiguous reports in
  `src/discovery/index.ts:222-225,392-399`). Default: root. Flag: **new**
  `--monorepo root|package --package <root>` on `setup` (D3: headless
  monorepo selection needs an explicit flag).
- `targets.install-method.shared` — explanation, not a choice: "A global
  npm install updates the `aiwg` CLI for every project; global provider
  config (`--scope user`) only changes one provider's user-level files."
  Shown once before `targets.scope.shared`. No flag and no answer: A3 and
  A4 never run `npm install -g`, and the provider-config half is already
  the `--scope user` answer. (Conductor decision with Jev, 2026-10-24.)
- `targets.scan-opt-in.shared` — "Also scan these extra directories
  (bounded)?" Default off / empty. Flag: reuses the discovery `roots`
  concept; **new** `--scan-roots <dir>` (repeatable) on `setup`.

### (b) Usage intent

- `intent.use.<scope>` — "What will this workspace use AIWG for
  (code, docs, ops)? Drives framework/capability suggestions." Default
  `code`. Flag: **new** `--intent code|docs|ops|mixed` on `init`/`setup`.
- `intent.team.<scope>` — "Solo or shared repo? Shared repos keep
  `force_push_policy=never`." Default `solo`. Flag: maps to existing
  `--force-push-policy` (`src/cli/handlers/setup.ts:195`) for the policy
  half; team size itself uses `--intent` above (no separate flag).

### (c) Tools and harnesses

Presence only — show `installed`/`configured`/`authenticated`/`qualified`
as observed, never probe.

- `tools.provider.<scope>` — "Which provider toolchains does this project
  target?" Default `claude` (init's default,
  `src/cli/handlers/init.ts:108,365`). Flag: existing `--providers <list>`
  (`src/cli/handlers/init.ts:181-191`, `src/cli/handlers/setup.ts:210-213`).
- `tools.worker-dispatch.<scope>` — "Two+ worker CLIs seen; run tasks in
  parallel?" Default decline/unasked. Flag: existing `--worker-dispatch
  enable|decline` (`src/cli/handlers/init.ts:179`,
  `src/cli/handlers/setup.ts:209`).
- `tools.scripts.<scope>` — "Add default scripts (deploy/doctor/sync)?"
  Default on. Flags: existing `--default-scripts true|false`,
  `--script <name>=<command>` (repeatable), `--custom-scripts true|false`
  (`src/cli/handlers/init.ts:193-200`).

### (d) Locations and credential-source names

- `locations.config-dir.<provider>` — "Where this provider's config file
  lives (informational; A3 writes nothing)." Default: provider's known
  path. Flag: existing `--target <dir>` selects the project dir
  (`src/cli/handlers/setup.ts:606`); per-provider config paths are
  interview-only (no new flag — a flag would imply A3 writes there).
- `locations.credential-source.<provider>` — "Where should A4 read this
  provider's credential from?" Default `null`. Flag: **new**
  `--credential <provider>=env:NAME|file:PATH|stdin` on `init`/`setup`.
  Only the reference shape is accepted.

### (e) Optional capabilities

Each defaults off; declining or skipping never activates anything (§8 tests pin this).

- `capabilities.signing.<scope>` — "Require signed delivery commits?"
  Default false. Flags: existing `--require-signed-commits`,
  `--signing-format`, `--signing-key`, `--signing-enforce`
  (`src/cli/handlers/setup.ts:196-200`).
- `capabilities.delivery.<scope>` — "Delivery mode and branch protections."
  Defaults `pr-required` / `never` force-push. Flags: existing
  `--delivery-mode`, `--default-branch`, `--require-ci-green`,
  `--auto-close-issues`, `--issue-comment-on-cycle`, `--force-push-policy`
  (`src/cli/handlers/setup.ts:190-195`, help text `:617-623`).
- `capabilities.tracker.<scope>` — "Issue tracker provider and remotes."
  Defaults from detected remotes (`src/cli/handlers/setup.ts:371-382`).
  Flags: existing `--primary`, `--issue-tracker`,
  `--customer-issue-tracker`, `--ci`, `--issue-provider`,
  `--customer-issue-provider`, `--tracker-actor-login`,
  `--tracker-actor-via`, `--customer-tracker-actor-login`,
  `--customer-tracker-actor-via` (`src/cli/handlers/setup.ts:184-205`).

New flags summary (all on both `init` and `setup` unless noted):
`--scope`, `--workspace` (setup), `--monorepo` + `--package` (setup),
`--scan-roots` (setup), `--intent`, `--credential`.

## 5. Navigation

- Ask-only-unanswered: on start (and resume), load the persisted plan with
  `readSetupPlan` (`src/discovery/plan-store.ts:68-85`), compute
  `unansweredPlanChoices` (`:93-96`), and prompt only for those — mirroring
  init's "supplied skips the prompt" (`src/cli/handlers/init.ts:373-377`)
  and setup's rebuild-only-missing flow (`src/cli/handlers/setup.ts:673-684`).
- Back: return to the previous question; the prior answer is shown and kept
  until replaced. Edit: jump to any answered question by ID; replacing an
  answer updates `answers[id]` (`source: 'interview'`, fresh `answeredAt`)
  and recomputes dependent recommendations/actions.
- Skip: leave optional questions unanswered; the plan records no answer and
  the question stays in `unansweredPlanChoices` for next time. Defer: like
  skip, plus `deferredAt` on the `UnresolvedChoice`, so the question is
  asked first in the next session. Required
  questions (§6) cannot be skipped headless; interactively, skipping a
  required question blocks completion with the missing-flag message.
- Cancel: exit without writing. A cancelled session leaves the store exactly
  as the last successful `writeSetupPlan` left it — writes are atomic
  temp-file + rename with cleanup (`src/discovery/plan-store.ts:41-66`),
  and a failed rename keeps the prior complete plan
  (`test/unit/discovery/plan-store.test.ts:97-104`). The interview saves
  progress incrementally (one `writeSetupPlan` per answered block), so
  cancel loses at most the current block.
- Every save validates (redaction scan over the serialized snapshot plus
  schema check) before bytes hit disk
  (`src/discovery/plan-store.ts:41-47`).

## 6. TTY rule

The caller makes the one shared interactive decision with `isInteractive`
(`src/cli/env.ts:44-52`, honoring explicit flags, TTY, TERM, CI,
DEBIAN_FRONTEND). Init already owns this pattern
(`src/cli/handlers/init.ts:267-275`); setup follows it
(`src/cli/handlers/setup.ts:655`). Downstream interview code MUST NOT
re-derive interactive-ness from `process.stdin.isTTY` again.

- Interactive: prompt only for unanswered, non-flag-supplied questions.
- Headless (`--non-interactive`/`--yes`, no TTY, or CI): never prompt.
  Every unanswered required question with no default fails with a usage
  error naming the exact flag, e.g. `Missing required choice
  'targets.root.<scope>': re-run with --monorepo root|package`. Monorepo
  root-vs-package and unknown-remote provider selection always fail
  headless without their explicit flags (D3; setup already refuses the
  equivalent unknown-provider write in
  `src/cli/handlers/setup.ts:686-700`).
- Strict flag parsing everywhere: a value-taking flag present without a
  usable value is a usage error, never "not given"
  (`src/cli/handlers/init.ts:172-203`, `src/cli/handlers/setup.ts:121-134`).

## 7. Boundary with A4

A3 records answers and builds `actions[]` with explicit `dependsOn`
(`src/discovery/plan-types.ts:42-50`). It performs no writes outside the
plan file, no credential resolution (references stay opaque until apply),
and no registry/memory mutation. A4 gates each action with
`revalidateSetupPlan` (`src/discovery/plan-store.ts:117-140`) and applies it.

Proposed action kinds (A4 owns the apply slice; names below are the
contract):

| kind | does (A4) | fact dependencies (A3 records) |
|---|---|---|
| `configure-provider` | write nothing; preserve an existing provider file, or defer a missing one to `deploy-framework` (`aiwg use`) | `tool(provider).installed`, `path(workspace, configPath)` (informational only), `project(workspace).layout` |
| `verify-provider` | read-back/qualify without secrets | `tool(provider).version`, `project(workspace).layout` |
| `write-project-config` | write `.aiwg/aiwg.config` update | `path(workspace, package.json)`, `project(workspace).layout`, `path(workspace, .aiwg/aiwg.config)` |
| `deploy-framework` | deploy suggested framework/capability | `project(workspace).layout`, `tool(provider).installed` |
| `register-project` | registry/memory entry for workspace | `project(workspace).root`, `path(workspace, .aiwg)` |
| `record-decline` | persist an explicit decline (e.g. worker-dispatch) | none (answer-only; clears offers like setup's choice-applied path in `src/cli/handlers/setup.ts:459-464`) |

Each action carries `workspace`, `provider`, `scope` (`project`|`user`),
and `dependsOn` selectors into the plan's inventory snapshot
(`src/discovery/plan-types.ts:37-50`). A4 treats `unknown`, truncated, or
changed facts as `unobserved`/`fact-changed`/`version-changed`/
`tool-not-installed`/`path-missing` per the revalidation rules and must
re-ask or refuse rather than apply stale actions. The first two kinds match
the v1 fixture (`test/unit/discovery/fixtures/setup-plan-v1.json:47-81`).

Two A4 judgment calls A5/A6 can rely on: `verify-provider` treats an
`unobserved` tool version (unknown at plan and apply time) as advisory
rather than stale, since the read-only check re-observes the tool from fresh
inventory; and a run where every core action applies but an optional
`deploy-framework` fails or skips exits 1 with a `Partial success` message
(classification `partial`), leaving the optional action eligible for retry.

### Plan-model change A3 makes

`UnresolvedChoice` (`src/discovery/plan-types.ts:29-34`) gains an optional
`deferredAt?: string` (ISO timestamp), validated in `plan-validation.ts`.
It is additive: v1 plans without it still load and validate, so no schema
version bump. This is the only A2 type change A3 needs.

## 8. Test plan

Conventions: discovery tests in `test/unit/discovery/` (store, fixtures,
golden JSON), CLI wizard tests in `test/unit/cli/` and
`test/unit/cli/handlers/` with mocked `ui`, `readline`, and `isInteractive`
(`test/unit/cli/handlers/init.test.ts:15-62`).

New files:

- `test/unit/discovery/interview-questions.test.ts` — ID convention
  (format, determinism, no index dependence), inventory-ID derivation, and
  merge precedence (explicit-flag wins; `false`/`null`/default count as
  answered per `unansweredPlanChoices`).
- `test/unit/discovery/interview-credentials.test.ts` — only
  `credential-ref` shapes persist; raw/secret-looking values rejected
  before any bytes are written (extend the existing redaction cases in
  `test/unit/discovery/plan-store.test.ts:117-184`); skip/defer leaves the
  choice unanswered yet the plan writable.
- `test/unit/cli/guided-setup-tty.test.ts` — scripted TTY session: mock
  `isInteractive → true`, feed scripted answers through mocked
  `prompt-utils`, assert the exact question order, back/edit/skip/defer/
  cancel semantics, ask-only-unanswered on resume, and atomic store state
  after cancel (mirrors the cancel/confirm flow in
  `src/cli/handlers/setup.ts:741-749`).
- `test/unit/cli/guided-setup-headless.test.ts` — headless parity: same
  answers supplied as flags produce a byte-identical plan (minus
  `answeredAt`/`source`) to the scripted TTY run; missing required values
  fail naming the flag; `MockIsInteractive → false` never prompts.
- Fold into both: "declined/skipped optionals never activate" — every
  optional capability declined or skipped yields no corresponding action
  and no config fragment, and `remainingPlanActions`
  (`src/discovery/plan-store.ts:88-91`) never resurrects it.
