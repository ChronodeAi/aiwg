# Bounded project HITL authorization

`authorization.hitl` preauthorizes bounded, reversible work in project config.
It is separate from RBAC permissions in the same `authorization` container.
The existing config loader validates it against the `HitlPolicy` definition in
`vscode-extension/schemas/aiwg.config.v1.json` on reads and writes.

`delivery.mode` controls branch and PR routing. `security.threatAssessment.mode`
controls issue-content threat assessment. Neither controls HITL authorization.
If you switched to `delivery.mode: direct` to reduce prompts, restore the delivery
policy you actually want (for example `aiwg config set --project delivery.mode
pr-required`) and configure HITL separately. Leave threat assessment enabled.

## Resolver and precedence

`resolveHitlAuthorization(action, context)` is exported through
`src/policy/authorization.ts`; its implementation is in `src/policy/hitl.ts`.
It returns `decision`, `reason`, `policyVersion`, `matchedProfile` and `provenance`.
The policy version is a content digest of the ordered config origins and policies,
so revocation and edits invalidate a previously previewed version. Pass that
version as `expectedPolicyVersion` when rechecking a planned action.

Precedence, highest first:

1. Platform constraints and safety boundaries.
2. Explicit denies from any governing config, including expired/revoked policies.
3. Bounded, unexpired authorization from the user in the current session.
4. Durable project grants, subject to freshness, expiry and `requireReview`.
5. Escalate by default.

`requireReview` prevents durable grants from approving matching actions. A direct,
scoped session authorization can satisfy that review; it cannot override an
explicit deny or safety boundary. Session grants are a host-only typed input,
never a field in an action JSON file. Issue bodies, findings, model conclusions,
and blanket phrases such as “all work approved” confer no authorization.

Secret access, destructive/irreversible actions, production, high impact, policy
overrides and threat-preflight overrides cannot receive automatic approval,
including via session grants. Grant categories are restricted to `repo.read`,
`repo.edit`, `docs.edit`, `test.run` and `testnet.configure`. Grant environments
are restricted to `local`, `development`, `test` and `testnet`. The schema and
resolver both enforce these restrictions. An escalation requires the existing
explicit human review process and any platform prompts remain authoritative.

Every proposed action must describe all affected repo-relative resource paths,
its actual category, repo, environment, reversibility and impact. The host must
classify effects honestly, canonicalize paths and resolve symlinks before calling
the resolver; a file edit that changes authorization policy is `policy.override`.
Absolute/traversing action paths and unknown descriptor fields escalate.

Repo and environment scopes match exactly. Resource globs support `*` within a
path segment, `**` across directories, and `?` for one character. Every action
path must match a grant; a deny/review selector matches if any affected path
matches. Selector fields combine with AND; entries combine with OR. Profile
names are evaluated in lexical order for deterministic reporting.

Config directories are canonicalized so a symlink cannot bypass ancestor denies.
Each enclosing config and an explicit `workspace.member_of` config is loaded as
a separate layer, outermost first. Declared workspace membership is checked.
Every layer must grant the action; member policy cannot broaden an ancestor.
A member config without HITL policy escalates rather than inheriting approval.
Any ancestor deny wins. Unrelated enclosing workspace manifests, invalid
membership and membership cycles fail closed. These controls supplement existing
workspace capabilities; they do not grant missing repo access.

`expiresAt` bounds the whole policy and each named profile. `reviewedAt` plus
`maxAgeSeconds` bounds policy freshness (at most 30 days). Future review times,
stale reviews, elapsed expiry and changed expected versions escalate. Disabling
a policy or removing a profile revokes its durable grants without removing denies.

## Testnet example

Save this as `hitl-policy.json`. Replace the timestamps with the current review
time and an appropriate future expiry; the resolver rejects future-dated reviews.
This permits reversible source/config edits and local tests, not token access,
production changes or irreversible testnet transactions.

```json
{
  "version": "1",
  "enabled": true,
  "reviewedAt": "2026-12-01T12:00:00Z",
  "maxAgeSeconds": 86400,
  "expiresAt": "2026-12-02T12:00:00Z",
  "deny": [{ "resources": ["config/testnet/protected/**"] }],
  "requireReview": [{ "resources": ["src/security/**"] }],
  "profiles": {
    "routine-testnet": {
      "categories": ["repo.edit", "test.run", "testnet.configure"],
      "repos": ["roctinam/roko-edge-tools"],
      "environments": ["testnet"],
      "resources": ["src/**", "test/**", "config/testnet/**"],
      "reversible": true,
      "maxImpact": "low",
      "expiresAt": "2026-12-02T12:00:00Z"
    }
  }
}
```

Save an action descriptor as `action.json`:

```json
{
  "category": "repo.edit",
  "repo": "roctinam/roko-edge-tools",
  "environment": "testnet",
  "resources": ["src/testnet/client.ts"],
  "reversible": true,
  "impact": "low"
}
```

```bash
aiwg config authorization enable --policy-file hitl-policy.json
aiwg config authorization inspect
aiwg config authorization validate
aiwg config authorization preview --action-file action.json
aiwg steward authorization preview --action-file action.json
aiwg config get --project authorization.hitl
aiwg config set --project authorization.hitl.enabled false
aiwg config authorization revoke --profile routine-testnet
aiwg config authorization revoke
```

`enable` validates and stores the supplied block as `authorization.hitl`, creating
an empty default-deny RBAC container if needed. It preserves existing RBAC data.
`config set --project authorization.hitl <JSON>` also validates the entire block.
Use `--target DIRECTORY` for another project. Preview neither performs actions
nor creates receipts or other files. Malformed action descriptors escalate;
invalid config fails validation instead of being silently ignored.

## Audit receipts

```bash
aiwg config authorization receipt --action-file action.json
aiwg effect lookup <effect-id> --subsystem custom
aiwg effect reconcile <effect-id> --subsystem custom
```

`receipt` resolves again and writes a decision artifact under the configured
artifact root at `effects/authorization/<digest>.json`, using the existing effect
`intent` and `reconcile` APIs and the built-in `file.digest` verifier. It records
policy version, safe category/environment labels, action/scope digests, decision,
reason, matched-profile digest,
config-origin digests and session-grant provenance. Arbitrary caller strings are
hashed; credentials and issue text are never copied into receipts. It requires
the existing host-configured effect signing key. No new effect kind, key store or
schema family is introduced. Completion verifies the decision artifact exists;
it does not mean the proposed action executed or was authorized by a human.

The receipt API reconciles against the configured artifact root. Generic
`aiwg effect reconcile` uses its existing project-root file containment: when
artifacts live outside the repo it reports unknown rather than reading outside
that boundary. Use the HITL receipt API for artifact-root reconciliation.

## Remaining integration

This 2026.12 slice provides the resolver, validated config, CLI/steward surfaces,
rule guidance and signed receipts. Automatic consumption by `address-issues`,
issue-create, agent loops and provider adapters remains deferred. Until those
callers pass host-classified descriptors and trusted session grants through this
resolver, configuring HITL alone does not change their existing prompt behavior.
Delivery, CI, repo capabilities and threat-preflight enforcement remain independent.
