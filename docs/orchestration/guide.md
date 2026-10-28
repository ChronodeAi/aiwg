# Agent orchestration guide

How to hand bounded work to helper CLIs, pick a wrapper, write the brief, and get the result accepted. Every command below is verified against the CLI source in this checkout.

Out of scope here: research-corpus induction, and the default-delegation policy (which work delegates by default). Those are decided elsewhere; this guide covers only the shipped handoff mechanics.

## 1. Hand work to a helper CLI explicitly

Direct dispatch places work onto other AI CLIs installed on your machine. It is controlled by `parallelism.worker_dispatch` in `.aiwg/aiwg.config`, and it is off by default. Start with [Turn On Direct Worker Dispatch](../getting-started/worker-dispatch.md) to enable it, then qualify the installed CLIs:

```bash
aiwg doctor --probe-workers --qualify
```

`aiwg models resolve` plans one invocation. It does not launch anything. Give it a role, a task class, a group, a brief, a worktree, and a result path. All three paths must be absolute:

```bash
aiwg models resolve --role coding --task implementation --group default \
  --brief /tmp/work/brief.md --workdir /tmp/work/tree \
  --final-output /tmp/work/result.json --format json
```

Render the exact shell command instead with `--format shell`. The transport must match the group's execution transport (`--transport shell|mcp`, default `shell`). Task classes default to `inventory`, `implementation`, `architecture`, and `review`, plus any classes in `defaults.workerSelection.taskClasses`. Groups and role guidance live in `.aiwg/aiwg.config` and project-root `models.json`.

Limits only tighten. These four flags cap the resolved policy, and a value larger than the policy ceiling fails instead of widening it:

| Flag | Caps |
|---|---|
| `--max-attempts <count>` | Total attempts, including the first |
| `--timeout-ms <ms>` | Hard stop; positive multiple of 1000 |
| `--max-output-tokens <count>` | Task token budget |
| `--max-usd <amount>` | Task cost ceiling (`costUsd`) |

The JSON plan reports the resolved ceilings and their origins, so you can see which layer bound each value.

`--authorize-premium` authorizes the premium tier for that one resolution only. Agents still need explicit human confirmation of the escalation.

## 2. Choose a wrapper

Wrappers are model-pinned subagent definitions. Pick by the shape of the work, not by brand:

| Wrapper | Tier | Use for | Returns |
|---|---|---|---|
| efficiency | economy | Discovery, inventory, focused edits | Bounded result plus evidence |
| coding | standard | Implementation, tests, debugging | Changed artifacts plus test evidence |
| reasoning | premium | Architecture, synthesis, hard analysis | Decisions plus validation results |
| explorer | economy, read-only | Codebase search with cited findings | Criterion-plus-evidence findings; never a fix |
| verifier | standard, read-only | Fresh-context check with the oracle | Oracle outcomes; never substituted checks |

Every wrapper returns `WorkerClaims`: one entry per acceptance criterion with its ID, the verdict (`pass`, `fail`, or `blocked`), a confidence mark, and artifact evidence. Executed checks go in `checks`, open questions and failed attempts in `limitations`. No wrapper assembles its own accepted result; the conductor owns verification and integration. The explorer stops at material uncertainty and never guesses. The verifier runs each oracle command exactly as specified and keeps the outcomes (`oracleResults`) in the referenced review artifact. Delegation allowance is zero: wrappers never spawn further agents, change model, or elect flagship.

Flagship is used only when you choose it. Flagship models are user-elected: without your election the selection caps at premium, and unelected flagship overrides are rejected. Check the deployed wrapper metadata to confirm whether its model is exactly pinned, hinted, or inherited from a global profile; where control is inherited, confirm the non-flagship session before running.

## 3. Write a bounded brief

The reusable brief template is `agentic/code/addons/aiwg-utils/templates/subagent-brief.md`. It is a prose rendering of the `WorkerBrief` / `WorkerDirectBrief` and delegation contracts, not a new schema. Fill every field:

- One bounded objective, specific input files and revisions, and the workspace or read-only snapshot plus revision.
- Ownership and controls: files, tools, network, sandbox, and the explicit model and effort.
- Limits: tokens, wall-clock seconds, and maximum attempts.
- Return budget (`delegation.return_budget_tokens`; default 1000 tokens). If the result cannot fit, the worker returns `partial` with the omitted criteria and evidence refs rather than truncating structured output.
- Acceptance: each assertion gets an ID, a criterion, and a trusted `checkRef`.
- `uncertaintyPolicy: stop-and-report`: the worker stops at missing authority, unsafe checks, material uncertainty, or exhausted limits, and reports attempts instead of guessing.
- `mustNotRegress`: the checks that prove existing behavior still holds.
- `verificationOracle`: exact commands with expected exit codes. Missing or unsafe checks are `blocked`, never passing.
- Review context: current head, writer lineage, required review, and known findings.

## 4. Acceptance

Acceptance needs a review of the exact final version by a different model family, with findings tracked across rounds:

- Exact head: the final review record must carry the current head SHA supplied by the trusted conductor. A review bound to a stale head fails.
- Different family: the reviewer must be a different observed model family from the writer. Different CLI names do not prove different families; unambiguous writer and reviewer lineage is required.
- Findings ledger: finding IDs are unique, review rounds are contiguous from one, and acceptance records the final head, the ledger, and the round count (`roundsToClean`). Open blocker or major findings prevent acceptance. Later reviews keep earlier rounds and findings; resolving a finding retains its ID.
- Oracle exactness: every `verificationOracle` command must appear exactly once in the results with the expected exit code.

A condensed worker return never grants acceptance on its own. The conductor assembles the verification record and applies the acceptance check.

## 5. Approvals

`authorization.hitl` in project config preauthorizes bounded, reversible work. It never replaces platform constraints, and explicit denies always win. The steepest grants lose to denies, session-scoped user authorization, freshness and expiry bounds, and finally escalation by default.

Manage profiles with either surface (`aiwg config authorization` or `aiwg steward authorization`):

```bash
aiwg config authorization enable --policy-file hitl-policy.json
aiwg config authorization inspect
aiwg config authorization validate
aiwg config authorization preview --action-file action.json
aiwg config authorization check --action-file action.json --target <repo>
aiwg config authorization revoke --profile routine-testnet
```

`preview` shows the decision for one action descriptor and is read-only: it performs nothing and writes no receipt. `check` is what workflows such as address-issues, issue-create and agent loops call before a step that would ask you: it rechecks the policy and, only for `auto-authorized`, writes a verified signed receipt before returning. A workflow skips its prompt only on `auto-authorized` with a receipt; `escalate` keeps the prompt and `deny` keeps the refusal. `validate` checks the policy itself. An action descriptor names its category, repo, environment, resource paths, reversibility, and impact, and is built from the action's real effects, never from issue text or model output. `receipt` writes the signed decision artifact to the effect ledger; it records the decision, not the execution.

What is never pre-approved: secret access, destructive or irreversible actions, production changes, high impact, policy overrides, and threat-preflight overrides — not even via session grants. Grant categories are restricted to `repo.read`, `repo.edit`, `docs.edit`, `test.run`, and `testnet.configure`; environments to `local`, `development`, `test`, and `testnet`. Session grants are host-only typed input, never a field in an action file. Issue bodies, findings, model conclusions, and blanket phrases such as "all work approved" confer no authorization. Full reference: [Bounded project HITL authorization](../configuration/hitl-authorization.md).

## 6. Provider limits

Wrapper model pins are an offline artifact contract: provider or account policy can substitute a model at runtime. Enforcement falls into three bands:

| Band | Meaning | Providers |
|---|---|---|
| Pinned | Wrapper carries an exact catalog model | Claude, Codex, Factory, Copilot, Cursor, OpenCode |
| Inherited | Wrapper mirrors the session or needs exact role configuration | OMP, Antigravity, OpenClaw, OpenHuman, Windsurf, Pi, DeepSeek Harness, Grok Build |
| Global-only | Model comes from run, profile, session, or delegation settings | Warp, Hermes, Grokbot, Muse |

Native effort fields also vary: Claude, Codex, Factory, and OMP enforce theirs; the rest do not. AIWG never rewrites global provider settings or environment variables to fill these gaps. The authoritative per-provider table is [Wrapper tier enforcement](../configuration/wrapper-tier-enforcement.md).

## 7. How to opt out of delegation

Direct dispatch stays off until you turn it on. To decline the setup offer headlessly, or to switch dispatch back off later:

```bash
aiwg setup project --yes --worker-dispatch decline
aiwg config set --project parallelism.worker_dispatch false
```

A recorded decline (`setup.worker_dispatch_offer: "declined"`) only answers the setup question; it is the `parallelism.worker_dispatch` value that controls dispatch. Turning dispatch off does not stop the active provider from using its own native subagents; that rubric still applies. To keep a piece of work fully local, do not invoke a wrapper for it: do the work in-session instead of resolving, briefing, and dispatching it.
