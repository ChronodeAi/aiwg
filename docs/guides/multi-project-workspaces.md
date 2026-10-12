# Working Across Multiple Projects

For one project, project scope is still the simplest start. AIWG also supports
several repositories under one assistant or one orchestrating session. This
guide explains how to arrange their context, declare access, and keep shared
work from carrying more information or authority than intended.

In brief:

- Set up AIWG in every repository you manage, so its notes, memory, and policy
  stay with it.
- Declare the workspace and its members once, at the root. Paths outside the
  listed member trees are denied.
- Decide what may cross between projects before you import history, share
  storage, or hand context to a worker.
- Keep one accountable conductor, give each worker one repository and one task,
  and size concurrency to what review and CI can absorb.
- Add checks as the workspace grows.

## The three layers

Keep repository work, workspace coordination, and personal defaults distinct.
They can coexist without using the same storage location or access policy.

| Layer | What it holds | Shared with | Examples |
| --- | --- | --- | --- |
| Member repository | Its policy and project records | Its collaborators, when tracked | `.aiwg/`, `.aiwg/aiwg.config` |
| Workspace root | Coordination | Root's operators and assistants | `WORKSPACE.md`, `workspace`, `repos`, root notes |
| User level | Defaults and private memory | User's sessions | Instructions, indices, user-level project memory |

The root configuration holds the `workspace` and `repos` blocks. Root notes
link work across members; each member still owns its implementation and policy.
User-level project memory associates private records with a registered project.
User-level indices deliberately make selected material available across projects.

`WORKSPACE.md` is the provider-neutral context entry point. Put concise operating
context and links in its Project Context section, and keep detailed procedures
in linked files. A plain link does not automatically load a file: startup
instructions must tell the assistant what to read.

## Initialize every repository you manage

Give each managed member its own AIWG setup and `.aiwg/aiwg.config`. The member
config controls delivery mode, branches, remotes, tracker authority, identities,
and commit and release-tag signing. A workspace allowlist does not replace it.
Keep notes, memory, and artifacts associated with the repository they describe.

> Set up AIWG for storefront and billing-api separately. Show each repository's
> delivery policy, tracker authority, identity, and artifact destination.

Choose how to retain project material before you initialize a member. The
choice is harder to change afterwards, because creating the member's `.aiwg/`
directory changes where memory resolves:

- **Version-control durable records.** Keep reviewed plans, decisions, and
  reusable notes available to collaborators. Ignore only high-churn runtime
  state, such as temporary work, regenerable indices, and loop state. Review
  content before tracking it; being eligible for version control is not proof
  that a file has been committed.
- **Ignore `.aiwg/` entirely.** This keeps local AIWG records out of repository
  history. Collaborators do not receive that material through the repository,
  so arrange its retention and sharing separately.
- **Use user-level project memory.** Registration keeps private memory outside
  the checkout and does not change the repository or require ignore rules.
  This suits personal notes; collaborators do not receive them automatically.
  It applies only while the repository has no local `.aiwg/` directory: once
  one exists, even holding nothing but configuration, memory resolves there.
  A member that has its own config therefore needs its memory location set
  explicitly in storage configuration to keep memory outside the checkout.

The last option is a memory arrangement, not a replacement for member policy.
A repository without its own config falls back to defaults and cannot express
its own delivery or tracker policy. The delivery rules tell the assistant to
stop before tracker or git writes when a member's config is missing or
ambiguous; that stop is a rule the assistant follows.

Registered user memory is matched by roots or remotes. Explicit memory storage
configuration takes precedence, then an existing local `.aiwg/` directory, then
registered user memory. Registration alone does not override local memory.

The artifact store defaults to `.aiwg/`, but configured external artifact roots
are supported. Resolve the actual destination before writing or changing ignore
rules. Repository control files stay local. Writers that resolve the artifact
root fail when a configured external root is unavailable, and do not redirect
payload into the checkout. Not every store goes through that resolution:
compound context is always kept under the checkout, and memory can resolve to
registered user storage. Confirm where each kind of record lands.

## Declare the workspace

Add membership to the root's `.aiwg/aiwg.config`. This example grants storefront
the delivery actions, billing-api read-and-comment access, and ops-runbooks reads:

```json
{
  "workspace": {
    "name": "delivery-workspace",
    "root": "/work/delivery-workspace"
  },
  "repos": [
    {
      "name": "storefront",
      "path": "./storefront",
      "allowed": ["read", "write", "commit", "push", "issue-comment"]
    },
    {
      "name": "billing-api",
      "path": "./billing-api",
      "allowed": ["read", "issue-comment"],
      "notes": "handoff-only"
    },
    {
      "name": "ops-runbooks",
      "path": "./ops-runbooks",
      "allowed": ["read"]
    }
  ]
}
```

Choose permissions for the intended work. Grant `service-action` (operating a
running service) and `destructive` (deleting or overwriting work) only where a
task needs them. Allowed actions are `read`, `write`, `commit`, `push`,
`issue-comment`, `service-action`, and `destructive`. Paths outside every
listed member, and unlisted actions, are denied by default. The `handoff-only` note explains intent;
the `allowed` list decides which actions the access check accepts.

Relative member paths resolve from `workspace.root`, or from the project that
owns the configuration when that root is absent. Absolute members are supported.
An external member can use `workspace.member_of` to identify its workspace;
`AIWG_WORKSPACE` provides explicit process-level discovery.

Membership follows paths, not Git boundaries. A repository nested inside a
listed member inherits that member's permissions even if it is never listed, so
list nested repositories separately when they need narrower access. A worktree
or clone outside every listed member tree is not a member, whatever repository
it belongs to: add it explicitly before working there.

Effective permission is the intersection of workspace permission, the member's
own policy, and any narrower repository instructions. This intersection is a
rule the assistant follows. The access check itself covers membership and
action; it does not perform the whole delivery-policy preflight.

> Check whether this workspace allows commits to billing-api, and tell me which
> rule decides it. Read the member's own policy before preparing a handoff.

For exact configuration and operation syntax, see
[workspace repository access](../security/repo-access-manifest.md) and the
[CLI reference](../cli/reference.md).

## Keep a workspace index

Use one entry file at the root, such as `WORKSPACE.md`, to link to dated plans,
reviews, research, decisions, and runbooks. Keep implementation detail in the
owning member and coordination detail at the root.

Annotate entries with **proposed**, **accepted**, **completed**, **blocked**, or
**superseded**. Link superseded entries to their replacements so an old decision
does not remain the easiest answer to find.

The index is a pointer to recorded work, not proof of current external state.
Re-check trackers and CI before relying on a delivery status, review outcome,
or release claim. Record which source is authoritative when copies differ.

Make operating rules part of the initial reading instructions. Cover outgoing
communication and approvals, authoritative sources, synchronization between
copies, worker and machine capacity, and separation of unrelated projects and
sensitive material. Link the detail instead of expanding the index indefinitely.

## Decide what may cross project boundaries

Decide sharing before importing history, selecting storage roots, or handing
context to another worker. Project-specific paths describe defaults; they do
not establish a universal read barrier around the project.

| Boundary | Material |
| --- | --- |
| Mixes by design | User-scope instructions, global bootstrap, user-level indices, storage set to a shared root |
| Stays with the project by default | Artifact store, memory addons, activity log, session catalog |
| Crosses only by explicit choice | Cross-workspace context import, shared session roots, repository registration |

User-scope deployment adds a mirror while retaining the project deployment.
The global bootstrap uses shared user assets with lightweight project context
files, subject to provider support. Neither is automatic shared project memory.
User-level indices can be queried from other workspaces. Disabling their default
merge still permits an explicit user-graph query.

Memory addons use project defaults: line memory under `.aiwg/memory/`, wiki
material under `.aiwg/wiki/`, and compound context under
`.aiwg/context/compound-memory/`. Semantic memory uses the configured memory
adapter. The activity log defaults to `.aiwg/activity.log`, shared by frameworks
within the project. Storage configuration can intentionally change destinations.

The session catalog defaults to `.aiwg/sessions/catalog.sqlite`. Reads resolve
an explicit, current, or unambiguous workspace; ambiguous scope fails. Supported
search paths filter by workspace. A different catalog location is configurable,
so inspect its scope as well as its filename.

**Rules the assistant follows:** bounded worker objectives, relevant context,
scoped outputs, member-specific delivery authority, and cross-repository
disclosure decisions. These instructions do not themselves sandbox arbitrary
tools. Registering a repository grants only its declared actions; it does not
authorize copying all of its content elsewhere.

**Checks enforced in code on particular paths:**

- Worker invocation checks containment within the served root and applicable
  manifest permissions. Local dataset adapters require `allowedRoot` and reject
  path escapes and symlink sources; remote sources are governed by network
  policy instead.
- Compound-context import requires `allowCrossWorkspace` for foreign workspace
  context. Session imports require authorized roots; discovery of shared Codex
  session history requires explicit root authorization.
- The context firewall scans drift, instruction-poisoning signals, and context
  budget. Strict mode provides a failing gate for reported violations. Its
  quarantine label does not relocate files, and its scope is one checkout.
- Session sanitizers redact known secret patterns, and storage configuration
  rejects credential keys. These targeted checks are not comprehensive data
  loss prevention.

> Review what this workspace shares through user instructions, indices, storage,
> and session imports. Identify each explicit sharing choice and its scope.

Use three practices when material crosses a boundary:

1. Write a neutral, reusable version of a finding into the project that owns it.
   Keep engagement-specific context where it was found. Review the new version
   for disclosure and retain only appropriate traceability links.
2. Use separate intake, working, and outgoing locations. Review incoming
   material before using it as context, and review outgoing content before
   sharing it. Directory names alone do not enforce that review.
3. Never share credentials between unrelated projects. Record where credentials
   live, never their values. Keep credential values out of context, notes, and
   storage configuration.

## Run work across repositories

Keep one accountable conductor responsible for integration, conflict resolution,
verification, and the final result. Give each worker a bounded task in one
repository, with relevant inputs, allowed outputs, and a completion criterion.

Use a separate worktree for each concurrent task. Record its owning repository
and base revision, avoid overlapping writers, and clean up after integration
and verification. Preserve unfinished work until its disposition is clear.
Keep worktrees inside a listed member tree, or list their location as a member:
a worktree elsewhere is outside the workspace as far as access is concerned.
A worktree inside a member inherits all of that member's allowed actions. List
a worktree location as its own member when a task should have narrower access.

Read the configured `parallelism` caps before launching work. The config keys
are `max_parallel_subagents`, `max_parallel_ralph_loops`, and
`max_parallel_mc_missions`. Providers default to one of two sets; these are
starting limits, not throughput promises:

| Providers | Subagents | Ralph loops | Mission Control missions |
| --- | --- | --- | --- |
| Codex, Copilot, Cursor, Factory, OpenCode, Warp, Devin Desktop, OpenClaw, Hermes | 10 | 3 | 6 |
| Claude Code and every other provider | 4 | 2 | 4 |

Apply the smallest relevant provider, project, context-budget, and task cap.
The three caps are not enforced the same way. Subagent caps are rules the
assistant follows. The Ralph loop cap is checked in code and refuses a launch
at the limit. The Mission Control cap warns and queues the mission; it does not
refuse it. None of these is a host-wide limit: sessions started independently
do not see each other unless they share a durable admission store, the record
that coordinates launches on a shared host.

CI and review throughput are usually the practical delivery limit. More workers
do not mean more finished work. Reduce concurrency when verification and
integration cannot keep up, and reconcile generated guidance with current caps.

Start orchestration from the project the work belongs to. Verify each result
independently by inspecting the actual changes and running the relevant checks;
a worker's success message is not sufficient evidence.

The effect ledger is a signed record of what an operation intended and what
happened, used to reconcile after an interruption. It does not authorize
actions or guarantee exactly-once execution. A recorded intent alone does not
establish that the target system accepted the operation.

## Add checks as complexity grows

Use the checks that match the workspace's complexity and handling requirements.
These tiers are operating guidance, not compliance certification.

| Workspace | Checks to include |
| --- | --- |
| A few repositories | Health check, engagement probe, repository-access audit |
| Many repositories or several people | Also mirror audit, skill and metadata lint, cleanup audit |
| Regulated or client-separated work | Also strict context firewall scan, test conformance review, CI gates, hooks |

Health checks, engagement probes, membership audits, skill and metadata lint,
and strict firewall scans run deterministic checks within their declared scope.
They report installation, deployment, membership, or content findings; none
establishes complete workspace readiness on its own.

Mirror and cleanup audits are assistant-driven workflows using repository
evidence; keep cleanup read-only while reviewing findings. Test conformance
combines deterministic inventory and validation with substantive review of tests.
Passing tests alone do not establish that their assertions check useful behavior.

CI gates and hooks require installation and configuration. Inspect the chosen
workflow before enabling it: some templates create pull requests. Whether a gate
is deterministic or assistant-driven depends on the checks it invokes.

> Check engagement in each member, audit workspace membership, and review mirror
> drift. Report the scope of each check and any state you could not verify.

## An optional portfolio view

For many repositories, keep a catalog file, a narrative inventory, a dated audit,
and baselines. A generic layout might use `catalog.yaml`, `inventory.md`,
`audits/2026-10-01.md`, and `baselines/`. These are maintained records, not an
automatic repository scheduler.

Use the catalog for membership, role, lifecycle, and source authority. Use the
inventory to explain responsibilities and unresolved ownership. Keep both on
the same repository set. Record audit methods and limitations alongside findings,
and distinguish verified lineage from hypotheses.

Baselines anchor later comparisons; they do not prove that a recovery copy can
be restored. Refresh changeable repository facts before acting on them.

## Common failure modes

- Generated tracker guidance or worker caps drift from member configuration.
- A checkout exists under the root but is absent from the access manifest.
- A repository nested inside a listed member silently inherits its permissions.
- A member gains a local `.aiwg/` directory and memory quietly moves into the checkout.
- Switching between root, member, and worktree obscures which policy applies.
- Long indices and synchronized copies retain stale decisions or excess detail.
- Worktrees spread across locations lose clear ownership and cleanup status.
- Catalogs, inventories, and outgoing presentations describe different states.
- Embedded source copies obscure authority; snapshots are mistaken for tested recovery.
- Shared directories or supposedly neutral findings disclose unrelated project context.

## Known limits

Mission Control uses one current-directory-derived project root per run; do not
assume it dispatches automatically to each member. Independently started projects
do not automatically share its admission file.

Read isolation is not universal. The repository-access audit examines immediate,
nonhidden child directories containing `.git` under the project that owns the
workspace configuration. It does not scan `workspace.root` when that differs,
nor nested or external repositories, so a clean audit covers only that level.

Provider precedence for user-scope mirrors varies; some mirrors are not
automatically scanned. Check the provider's documented loading behavior.

## Related documentation

- [Workspace repository access](../security/repo-access-manifest.md)
- [Scope precedence](../customization/scope-precedence.md)
- [User-scope deployment](../customization/user-scope-deployment.md)
- [Scope and recovery](../getting-started/scope-and-recovery.md)
- [User-level project memory](../user-level-project-memory.md)
- [User-level indices](../user-level-indices.md)
- [Storage overview](../storage/overview.md)
- [Context and memory firewall](../security/context-memory-firewall.md)
- [Session catalog reference](../sessions/cli.md)
- [Workspace context](../configuration/workspace-context.md)
- [CLI reference](../cli/reference.md)
