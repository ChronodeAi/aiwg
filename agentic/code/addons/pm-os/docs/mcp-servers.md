# MCP Servers in PM OS

PM OS ships 6 Model Context Protocol (MCP) servers preconfigured in `.mcp.json`. They give the PM AI direct, live access to your podcast research library, Notion workspace, Linear backlog, Jira/Confluence, GitHub repos, and Perplexity search — without you wiring anything up.

This doc covers: what each server does, what auth it needs, what tools it exposes, and known limitations. Plus a "bring your own" section for Slack and other servers PM OS does not preset.

---

## The bundle (6 servers)

| Server          | What it is                                       | Auth                        | Setup effort                         |
| --------------- | ------------------------------------------------ | --------------------------- | ------------------------------------ |
| `lenny-podcast` | Search 284 Lenny's Podcast transcripts           | None — public               | None                                 |
| `notion`        | Notion's official hosted MCP                     | OAuth (browser, first call) | Click "Authorize" the first time     |
| `linear`        | Linear's official hosted MCP                     | OAuth (browser, first call) | Click "Authorize" the first time     |
| `atlassian`     | Atlassian Rovo MCP — Jira + Confluence + more    | OAuth 2.1 + DCR (browser)   | Click "Authorize" the first time     |
| `github`        | GitHub's official hosted MCP (via Copilot infra) | OAuth (browser, first call) | Click "Authorize" the first time     |
| `perplexity`    | Perplexity's official local stdio server         | `PERPLEXITY_API_KEY` env    | Set env var (requires paid API plan) |

All six servers register automatically when the PM OS plugin loads. You do not need to edit `.mcp.json` to enable them.

---

## How OAuth works for hosted servers (Notion, Linear, Atlassian, GitHub)

The first time the AI calls one of these servers in a session, your MCP client (Claude Code, Cursor, or Cowork) opens a browser tab to the server's OAuth page. You sign in, click "Authorize," and the client stores the token locally. Subsequent calls in the same session and later sessions reuse that token until it expires or you revoke it.

You grant access at the scope of your own user account — the server can only see workspaces, repos, pages, or issues that you already have access to. No admin install required.

To revoke access later: go to the connected app's authorized apps list (e.g. Notion → Settings → Connections; Linear → Settings → API → Authorized applications; Atlassian → Manage account → Apps; GitHub → Settings → Applications → Authorized OAuth Apps) and remove the entry.

---

## Per-server detail

### `lenny-podcast` — Lenny's Podcast transcript search

- **URL:** `https://lenny-mcp.onrender.com/mcp`
- **Tools:** `search_transcripts`, `get_episode`, `list_episodes`
- **Auth:** None — public read-only
- **Cold start:** Runs on Render's free tier. After 15 minutes of inactivity the dyno sleeps; first request after idle takes ~15–30 seconds. Subsequent requests are sub-second.
- **PM use case:** Pull a quote from a Lenny episode straight into a research synthesis, find the right episode for a topic, get the full transcript of an interview.

### `notion` — Notion workspace

- **URL:** `https://mcp.notion.com/mcp`
- **Tools (~18):** `search`, `fetch`, `create-pages`, `update-page`, `move-pages`, `duplicate-page`, comment create/get, user list/me, `query-data-source`, `create/update-data-source`, `retrieve-database`, block operations
- **Auth:** OAuth — Notion only sees pages and databases your user account already has access to.
- **PM use case:** Ask the AI to find a PRD across your workspace, pull notes from a recent meeting, append a section to a strategy doc, query your roadmap database.
- **Rate limits:** Standard Notion API — ~3 requests/sec average.

### `linear` — Linear product backlog

- **URL:** `https://mcp.linear.app/mcp`  *(the older `/sse` endpoint is deprecated)*
- **Tools:** search/create/update issues with filters (assignee, priority, status, labels, dates); list/get projects; manage milestones, initiatives, cycles; add comments; list teams and users; update project health.
- **Auth:** OAuth — scoped to whichever workspace you authorize. Multi-workspace users re-auth to switch.
- **PM use case:** "Show me all open issues for the checkout team this cycle"; "Create a new issue under project X with this description"; "Summarize the last 2 weeks of progress on initiative Y."
- **Rate limits:** Inherits Linear's GraphQL API — ~1,500 requests/hour per token.

### `atlassian` — Jira, Confluence, Compass, Bitbucket

- **URL:** `https://mcp.atlassian.com/v1/mcp`  *(the older `/v1/sse` endpoint sunsets June 30, 2026)*
- **Branding:** Atlassian markets this as "Rovo MCP Server." Same product, same endpoint.
- **Tools:** Semantic search across Jira + Confluence; create/update/link Jira issues and epics; create/update Confluence pages; Compass entity tools. Bitbucket Cloud and Jira Service Management tools require API tokens (OAuth/DCR is not supported for those).
- **Auth:** OAuth 2.1 + Dynamic Client Registration. **Cloud only** — Data Center / Server are not supported.
- **PM use case:** Pull all Jira tickets for an epic, search Confluence for prior product specs, create linked tickets across projects, update issue status from a sprint review summary.
- **Plan tier:** No truly free path. Requires Atlassian Standard, Premium, or Enterprise. Free-tier sites can connect but most tools are gated by Rovo credits (25 / 70 / 150 per user per month by tier).
- **Admin gate:** Org admins can allowlist which MCP clients connect. If you see "client not allowed," that's the cause.

### `github` — GitHub repos, issues, PRs, Actions

- **URL:** `https://api.githubcopilot.com/mcp/`
- **Tools (~120 across 21 toolsets):** repos, issues, pull_requests, users, code search, actions, code_security, dependabot, discussions, gists, git, labels, notifications, organizations, projects, secret_protection, security_advisories, stargazers, and more.
- **Auth:** OAuth — **no GitHub Copilot subscription required for the server itself.** Individual tools inherit GitHub feature gating (e.g. Copilot cloud-agent tools need a paid Copilot seat, but core repo/issue/PR/action tools do not).
- **PM use case:** "What PRs shipped this week for repo X?"; "Open an issue in repo Y with this title and body"; "Search the codebase for usages of feature-flag Z."
- **Enterprise:** GitHub Enterprise Cloud with data residency works on the remote server (`--gh-host` flag for local). GitHub Enterprise Server requires the local Go server — see [github/github-mcp-server](https://github.com/github/github-mcp-server).

### `perplexity` — Web research via Perplexity AI

- **Command:** `npx -yq @perplexity-ai/mcp-server` (stdio — runs locally per session)
- **Tools:** `perplexity_search` (Search API), `perplexity_ask` (sonar-pro chat), `perplexity_research` (sonar-deep-research), `perplexity_reason` (sonar-reasoning-pro). Model selection is per-tool — no model param needed.
- **Auth:** Requires `PERPLEXITY_API_KEY` in the environment. Get a key at <https://www.perplexity.ai/account/api/group> — this requires a **paid Perplexity API plan**, not the consumer Pro subscription.
- **Activation:** Without the key, the server fails on first call but does not break anything else. Set the env var in your shell profile (`export PERPLEXITY_API_KEY=...`) or your MCP client's env config and restart the client.
- **PM use case:** Live competitive research, sanity-check facts with up-to-date sources, deep-research a market trend with citations.
- **Cost note:** `perplexity_research` and `perplexity_reason` burn credits quickly. Watch the dashboard when running long research sessions.
- **Tip:** Pass `strip_thinking: true` to the research/reason tools to save tokens by stripping `<think>` blocks.

---

## Bring your own — servers PM OS does *not* preset

### Slack

PM OS does not preset Slack. The official Slack MCP at `https://mcp.slack.com/mcp` requires a registered Slack app *in your workspace* — which most PMs cannot create without admin / IT approval. Presetting it would create a first-run authentication failure for the majority of users.

If you do want Slack, you have three paths in increasing order of friction:

1. **Slack's own Claude Code plugin** (easiest if your workspace allows it):
   ```
   claude plugin install slack
   ```
2. **Manual `.mcp.json` entry** (if you have a workspace where you can install an app):
   ```json
   "slack": { "type": "http", "url": "https://mcp.slack.com/mcp" }
   ```
3. **Bot-token community servers** like `zencoderai/slack-mcp-server` (the maintained successor to the archived Anthropic reference server). Requires creating a Slack app with a bot user and a `xoxb-…` token.

> ⚠️ Do not ship a Slack MCP server that uses browser-stolen `xoxc-…` / `xoxd-…` cookies (some community servers offer a "stealth mode"). It bypasses your workspace admin and likely violates your employer's acceptable-use policy.

### Other servers (Exa, Firecrawl, PostHog, Supabase, Vercel, DataForSEO, LaunchDarkly, Asana, …)

These are excellent but are either narrowly engineering-focused or require per-user API keys that don't ship cleanly as a preset. Add them with `claude mcp add` or by editing your own `.mcp.json` — none of them conflict with the PM OS presets.

---

## Disabling a preset server

If a server is causing issues (cold start, OAuth churn, scope you don't want to grant), you can disable it without losing the rest of the bundle:

**Claude Code:** edit `.mcp.json` in your workspace and remove the offending entry, OR use `claude mcp remove <server-name>`.

**Cursor:** edit `.cursor/mcp.json` in your workspace and remove the entry.

**Cowork:** the plugin's `.mcp.json` ships inside the uploaded ZIP; to disable a server you'd need to rebuild the ZIP with a custom `.mcp.json`. Easier path: just don't authorize the server when prompted, or revoke its OAuth token after authorization.

---

## Verifying servers are loaded

In Claude Code, run:

```
/mcp
```

You should see all 6 servers listed with their status. Hosted ones show `connected` (or `disconnected` until first call); `perplexity` shows `running` if the env var is set, otherwise an error.

In Cursor, open Settings → MCP. In Cowork, the servers appear in the MCP panel of the workspace once the plugin is uploaded and enabled.
