# AIWG roadmap

AIWG ships on calendar versioning (`YYYY.MM.patch`). The next release is the next patch of the current month. Work that slips past month end ships in the following month's first release. Scope for each release is tracked as a milestone in the canonical issue tracker; this page is the public summary.

The roadmap is organized by **bets**: outcomes we think AIWG users need next. Each bet has a `bet:*` issue label. Items move between Now, Next and Later at each monthly review.

- **Now**: in the current release train, being built.
- **Next**: designed or scoped, starts when Now frees capacity.
- **Later**: committed direction, not yet scoped.

## Now

### Rule binding: scoped rule activation (`bet:rule-binding`) — release 2026.10.4

Move rules from "always loaded in every session" to "delivered with the skill, agent or flow that needs them".

- Today a typical SDLC deploy keeps about 60K tokens of rules and behaviors in every session and every subagent. The size-based inline budget also drops some important rules entirely.
- Target: every rule declares an activation mode (`kernel`, `summary`, `bound`, `paths`, `on-demand`). The deployer, `aiwg show` and the MCP server honor it on every provider. Bound rules are delivered when their skill, agent or flow is used.
- Expected result: about 80% less always-loaded rule context per session and per subagent, and no rule silently lost to the budget.
- Ships as one release with the full migration, validated end to end: design record, measurement and probe harness, schema and lint, deployer injection for all providers, `bound_rules[]` in `aiwg show` and MCP, and all migration waves across the rule corpus.

## Next

### Accepted work episodes (`bet:accepted-episodes`)

A first-class record for "this piece of work was accepted": objective, inputs, authority, run, rubric, evidence, reviewer disposition and corrections. Built on Mission records and the effect ledger.

- Work cannot reach `accepted` without a reviewer other than the author and at least one evidence reference.
- One view shows drafted / tested / deployed / accepted per episode.
- Review time and rework are recorded, so cost per accepted outcome can be measured.

### Durable recovery and action-bound approvals (`bet:recovery-approvals`)

Surviving a restart is not the same as recovering the work.

- An adapter interface for effect-ledger reconciliation: a crash between commit and acknowledgement never produces a duplicate external effect on replay.
- Approvals are bound to actor, action and input hash; denials persist across restarts; approvals can expire and be revoked.
- A reference adapter and conformance tests.

## Later

### Cross-repo checkpoints (`bet:multi-repo-checkpoint`)

A workspace manifest and verifier runner that qualifies several repositories at once and emits one signed checkpoint receipt. Stale indexes and orphan artifacts surface as findings that must be dispositioned, not warnings. Receipts link to accepted work episodes.

### Governed intake and source precedence (`bet:controlled-intake`)

- Declared source precedence per project. Conflicting facts produce a decision item instead of a silent pick.
- Superseded sources are marked and excluded.
- Required-but-missing inputs block dependent work with a visible reason.
- Inputs marked restricted are refused by providers that are not approved for that project.

### Standards-native distribution and a hosted tier (`bet:distribution-paid-tier`)

- Serve AIWG skills over the MCP Skills extension (`skill://`, `skills/list`, `skills/get`) with `.well-known` server metadata, passing the extension's conformance suite.
- Remote MCP transport for application integrations, and MCPB delivery for desktop clients.
- A decision on the hosted API and authentication contract for a team tier: skills registry endpoint, evidence storage and governed-delivery reports.

## Ongoing quality work

- Full repository test audit and correction (test-audit epic and its children).
- Delegation economics: measured cost-effectiveness of right-sized subagents and model tiers.
- Some live qualification work is parked until dedicated live-test infrastructure is budgeted.

## How to influence the roadmap

Open an issue using the **Roadmap Item** template. Good proposals state the problem, who hits it, checkable acceptance criteria and the evidence behind it.
