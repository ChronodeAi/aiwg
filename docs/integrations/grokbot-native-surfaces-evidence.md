# Grok Bot native surfaces — product evidence catalog (#209)

**Status:** Operator handoff drafts available; native writers evidence-gated

**Date:** 2026-09-20
**Parent:** [#209](https://github.com/jmagly/aiwg/issues/209)  
**ADR:** [`docs/architecture/adr-grokbot-provider-target.md`](../architecture/adr-grokbot-provider-target.md)  
**Provider guide:** [`docs/integrations/grokbot-quickstart.md`](./grokbot-quickstart.md)

## Purpose

### Maintainer-approved interim scope (2026-09-20)

`aiwg bot-handoff --provider grokbot --input proposal.json` now emits operator-reviewed drafts
for routines, teammate profiles, connector recommendations and memory
references. See [handoff format and review steps](bot-handoff.md). This
resolves the interim-generator decision below; native installers remain gated.

The earlier blanket statement that Grok Bot has no API is too broad. The
[Cursor Admin API](https://cursor.com/docs/account/teams/admin-api#grok-bot)
documents `GET /grok-bot/capabilities`, including the team's `localExecution`
ceiling. This can support a separately scoped team-policy reader for #244; it
does not establish individual machine reachability or effective local policy.
No such probe is implemented by the handoff generator.

Current connector UX uses Marketplace rather than the older Settings → Plugins
wording below. Native routine/profile/memory import contracts and an automated
connector installer were not established by this review.

For AI coding tasks in CI, use the separate
[Grok Build provider and verification path](grok-build-ci.md). Grok Bot Admin
API access is not a dependency of Grok Build deployment. The historical catalog
below records why the original native writers were deferred.

Catalog each optional Grok Bot native surface from #209 against **public product
docs** (operator-reproducible UX) and record what is still **missing** for an
AIWG-consumable import/API/reload contract. This cycle progresses evidence and
issue decomposition only. It does **not** invent filesystem writers, silent
installs, or capability-matrix claims that AIWG installs routines / MCP /
CreateAgent profiles / memory / machines.

## Child issues (one surface each)

| # | Surface |
|---|---|
| [#241](https://github.com/jmagly/aiwg/issues/241) | Routines/cron import generator |
| [#242](https://github.com/jmagly/aiwg/issues/242) | CreateAgent/teammate template projection |
| [#243](https://github.com/jmagly/aiwg/issues/243) | Connector/MCP install profile |
| [#244](https://github.com/jmagly/aiwg/issues/244) | Registered-machine health probe (read-only) |
| [#245](https://github.com/jmagly/aiwg/issues/245) | Memory reference helper (no secret scrape) |

Evidence PR: [#240](https://github.com/jmagly/aiwg/pull/240).

## Product evidence sources (2026-09)

| Doc | URL | Relevance |
|---|---|---|
| Overview | https://docs.x.ai/grok-bot/overview | Shared cloud computer; connectors; skills/routines as product UX |
| Bots (Create / profile) | https://docs.x.ai/grok-bot/bots | Create new agent, Edit Profile, duplicate/share/delete Bot |
| Skills, routines, automations | https://docs.x.ai/grok-bot/skills-routines-and-automations | Skills via chat / Plugins; routines via schedule or event; manage UI |
| Computer and apps | https://docs.x.ai/grok-bot/computer-and-apps | Plugins/connectors; shared `/workspace`; local computer separate |
| FAQ | https://docs.x.ai/grok-bot/faq | Skill vs routine; memory; local vs cloud computer |
| Chat and collaboration | https://docs.x.ai/grok-bot/chat-and-collaboration | `@` mentions for Bots/groups/routines/connectors; `/` for skills |
| Approvals / local computer (adjacent) | https://docs.x.ai/grok-bot/approvals-security-and-privacy | Settings → General → Agent → Execution on Local Computer |
| Settings (adjacent) | https://docs.x.ai/grok-bot/settings-and-notifications | Timezone for routines; local-computer execution setting |

**Critical ADR constraint:** these pages document **operator UX** (ask the Bot;
Settings → Plugins; View conversation details → Routines). They do **not**
publish an AIWG-consumable import/API contract, on-disk schema, reload hook, or
CLI for writers.

## Global disablement / ownership rules (all surfaces)

Until a surface is unblocked by explicit product import/API evidence:

1. Keep AIWG baseline `aiwg use --provider grokbot` discover-first only.
2. Do **not** write routines, Bot profiles, connector configs, machine
   registrations, or memory stores.
3. Do **not** flip the capability matrix to claim AIWG installs those natives.
4. Any future adapter must be **opt-in**, confirmation-gated, and
   disableable without breaking baseline deploy.
5. Never overwrite operator-authored skills, profile, shared/project memory,
   routines, connectors, or teammate definitions (ADR ownership).

---

## Surface 1 — Routines / cron (and event triggers)

| Field | Value |
|---|---|
| Child tracking | [#241](https://github.com/jmagly/aiwg/issues/241) routines/cron import generator |
| Product doc | https://docs.x.ai/grok-bot/skills-routines-and-automations |
| Related | FAQ skill-vs-routine; Settings timezone; chat `@` routines |

### Verified (UX)

- A **skill** is how; a **routine** is when (schedule or, where supported, event).
- Operators create routines by **asking the owning Bot** (natural-language
  schedule, inputs, approval boundary, failure policy).
- Event triggers may use Cursor account integrations (e.g. Slack/GitHub
  notification) — separate from Plugins.
- Management UI: Bot → View conversation details → Routines (enable/pause,
  test run, edit, inspect runs, delete). Caps: ≤50 routines/Bot; 20 recent runs.
- Background routines can run with the laptop closed (cloud computer).

### Missing (AIWG contract)

- No published import format (JSON/YAML/TOML), filesystem path, or API to
  create/update routines from an external tool.
- No documented reload/sync hook after an out-of-band write.
- No schema for schedule timezone binding beyond “Settings timezone.”
- No idempotent upsert / ownership marker contract for AIWG-managed entries.

### Proposed AIWG adapter shape (when unblocked)

- **Generator only after import contract exists:** map AIWG scheduled intents →
  product import payload; dry-run by default; write only with explicit
  confirmation and a disable flag (e.g. `AIWG_GROKBOT_ROUTINES=0`).
- Until then, the only safe interim (if maintainer authorizes) is a
  **prompt/handoff pack** under `AIWG_GROKBOT_SKILLS_DIR` that emits operator
  instructions to paste/ask the Bot — never silent install.

### Disablement requirement

Feature flag / env kill-switch; removing the adapter must leave baseline
`grokbot` deploy and doctor unchanged.

---

## Surface 2 — CreateAgent / teammate template projection

| Field | Value |
|---|---|
| Child tracking | [#242](https://github.com/jmagly/aiwg/issues/242) CreateAgent/teammate template projection |
| Product doc | https://docs.x.ai/grok-bot/bots |
| Related | Overview; chat-and-collaboration group chats / handoffs |

### Verified (UX)

- Create flow: New → **Create new agent** → Edit Profile (name, title,
  description, avatar).
- Bots can suggest/create focused Bots; Duplicate copies profile/settings/
  enabled skills/routines/avatar but **not** conversation history, learned
  memory, or attachments.
- Share via public link → recipient **Add to Grok Bot** (copy; no computer/
  logins/history transfer).
- Group chats (2–6 Bots) and Bot-to-Bot async handoffs are product UX for
  teammate coordination.

### Missing (AIWG contract)

- No stable CreateAgent / profile **API** or import schema for projecting AIWG
  agent definitions into Grok Bot profiles.
- No documented on-disk profile path AIWG may write.
- No reload contract after external profile mutation.
- No mapping guarantee between AIWG agent IDs and Grok Bot identities.

### Proposed AIWG adapter shape (when unblocked)

- Project curated AIWG agent templates → product profile import (or API),
  opt-in per agent, with ownership markers and “never overwrite operator
  description” rules.
- Until unblocked: discover/show only; optional handoff prompts describing
  recommended Bot jobs — no profile writers.

### Disablement requirement

Per-surface toggle; baseline must not call CreateAgent or claim teammate
install in status/matrix.

---

## Surface 3 — Connector / MCP install profile

| Field | Value |
|---|---|
| Child tracking | [#243](https://github.com/jmagly/aiwg/issues/243) connector/MCP install profile |
| Product doc | https://docs.x.ai/grok-bot/computer-and-apps |
| Related | Skills/Plugins (`Settings → Plugins`); overview connectors mention |

### Verified (UX)

- Connectors appear as **Plugins**: Settings → Plugins → Add → browser auth.
- In chat, `@` attaches a connector; `/` references a saved skill.
- Prefer connector over browser when available; connectors are **account-wide**.
- Packaged skills also install/enable via Settings → Plugins → Yours.

### Missing (AIWG contract)

- No published MCP/connector **config file format**, install API, or reload
  procedure AIWG can drive.
- No documented way to register an AIWG MCP sidecar as a Grok Bot Plugin
  without operator UI.
- No attestation that AIWG may write connector credentials or plugin state
  (must not).

### Proposed AIWG adapter shape (when unblocked)

- Emit an **install profile** (declarative list of recommended connectors +
  operator steps) and, only if product documents it, a non-secret config
  fragment applied via documented import/reload.
- Never store OAuth tokens or scrape plugin secrets.

### Disablement requirement

Opt-in profile generation only; default deploy must not install or claim MCP
connectors for `grokbot`.

---

## Surface 4 — Registered-machine health probe (read-only)

| Field | Value |
|---|---|
| Child tracking | [#244](https://github.com/jmagly/aiwg/issues/244) registered-machine health probe (read-only) |
| Product doc | https://docs.x.ai/grok-bot/computer-and-apps |
| Related | Approvals (Execution on Local Computer); FAQ; Settings |

### Verified (UX)

- Primary runtime is a **persistent shared cloud computer** (`/workspace`,
  browser, terminal) — account-scoped, not per-Bot.
- **Local computer is separate:** Bot runs local commands only when enabled and
  approved under Settings → General → Agent → Execution on Local Computer
  (Ask every time / always / never).
- Cloud recover/update/reset flows exist in Settings → Beta; they are product
  UI, not an AIWG API.
- Docs describe policy and separation; they do **not** expose a “registered
  machine bridge” import or health endpoint for external tools.

### Missing (AIWG contract)

- No published machine-registration API, bridge ID schema, or health probe
  endpoint AIWG can call.
- No documented local-agent status JSON/path for read-only polling.
- Linux local-computer details are thinner than macOS/Windows wording in places;
  do not invent paths.

### Proposed AIWG adapter shape (when unblocked)

- **Read-only** probe: report reachability / policy mode if product exposes a
  safe status surface; never enable local execution, never register machines,
  never write credentials.
- Until then: doctor/status may only state “Grok-owned; no AIWG machine
  bridge.”

### Disablement requirement

Probe must be skippable; failures must not fail baseline `aiwg use`.

---

## Surface 5 — Memory reference helper (no secret scrape)

| Field | Value |
|---|---|
| Child tracking | [#245](https://github.com/jmagly/aiwg/issues/245) memory reference helper (no secret scrape) |
| Product doc | https://docs.x.ai/grok-bot/bots (What a Bot remembers); FAQ; overview |
| Related | ADR discover-first: store references/summaries — never full bodies |

### Verified (UX)

- Bots retain stable preferences, role context, and summaries; conversations
  and learned context are per-Bot.
- Shared files / browser sessions / handoffs move context between Bots on the
  shared computer.
- Product guidance: for consequential decisions, check the current source —
  memory is not authoritative.
- Duplicate Bot does **not** copy learned memory.

### Missing (AIWG contract)

- No published memory import/export API, on-disk memory schema, or approved
  write path for external tools.
- No safe “append reference note” contract distinct from scraping secrets/
  sessions/files on the shared computer.

### Proposed AIWG adapter shape (when unblocked)

- Helper that proposes **operator-approved** short references/summaries (paths,
  issue URLs, `aiwg show` pointers) for the operator to paste or approve —
  never scrape clipboard, cookies, credentials, or full artifact bodies.
- Align with ADR: references/summaries only.

### Disablement requirement

Default off; must not run as part of baseline deploy; no secret scrape ever.

---

## Decision gate (unblock criteria)

A child surface may move from **Blocked** to implementation only when **all**
are true:

1. Public product docs (or maintainer-attested operator evidence) publish an
   import/API/reload contract suitable for automation.
2. Contract is cited in the implementation PR with reproduction steps.
3. Adapter is isolated (tests + docs section), confirmation-gated, and
   disableable without affecting baseline `grokbot`.
4. Capability matrix remains honest (native *capability* ≠ AIWG installer).

## Explicit non-goals this cycle

- Inventing `~/.grokbot` (or any default) writers for routines / profiles /
  connectors / memory / machines.
- Silent Plugin or routine installs.
- Claiming live-refresh or Cursor reload wording for these surfaces.
- Folding xAI Grok Build into this provider.

## Original questions and current disposition

1. Interim handoff generation approved on 2026-09-20. The command prints drafts;
   retain them in the canonical artifact store before an explicit provider export.
2. Native installation priority remains separate. None of these optional Bot
   integrations gates AIWG deployment to Grok Build CI jobs.

## Related: baseline loading (not #209 writers)

Default path for AIWG on a Grok Bot cloud computer is **global install**, not a Steward Bot:

See [grokbot-cloud-session-global-install.md](./grokbot-cloud-session-global-install.md).

`AIWG_GROKBOT_SKILLS_DIR` + `aiwg use all --provider grokbot` (+ project `use` in repos). Steward Bot only when mutating Grok-native routines/teammates/connectors.
