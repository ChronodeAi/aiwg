# Setting Up a Team

> **First time using AIWG?** Begin with [Install, Connect, and Verify](install-connect-verify.md). This guide assumes
AIWG is connected to the target project and your provider session can read the deployed context.

Different people on your team use different AI tools. One person uses Claude
Code, another uses Cursor, another uses GitHub Copilot. AIWG gives the project
a shared context and provider-specific files so each tool starts from the same
repo facts and conventions.

The useful team outcome is a committed `.aiwg/` context plus provider files
that each teammate can verify from their own tool.

Each section starts with what you can ask your assistant, then gives the command reference.

---

## How it works

> "Share this project's AIWG context across Claude, Cursor, and Copilot so each tool starts from the same repo facts."

Your assistant deploys the shared context once per provider and tells each teammate how to verify the handoff from their own tool.

Run [Install, Connect, and Verify](install-connect-verify.md) from the project
root for the first provider. Repeat the deployment step for each provider the
team uses. AIWG writes provider-specific files such as:

```
.claude/agents/          ← Claude Code picks this up
.cursor/agents/          ← Cursor picks this up
.github/agents/          ← Copilot picks this up
.factory/droids/         ← Factory AI picks this up
```

Commit the generated provider files and `.aiwg/` artifacts that your team has
reviewed. Teammates can then verify the handoff from their own provider
session.

---

## Setup For Multiple Providers

> "Deploy the complete AIWG system to claude, cursor, copilot, and warp, then commit the reviewed provider files."

Your assistant builds the shared capability index for each provider, verifies each deployment, and stages the commit of the reviewed files.

Each `aiwg use` invocation builds the shared capability index, connects that
provider to the project context, and verifies the deployment before returning.

Then commit the results:

Everyone who pulls gets the reviewed project context and provider files.

### Command reference

```bash
cd /path/to/your/project

# Deploy the complete system to each provider
aiwg use all --provider claude
aiwg use all --provider cursor
aiwg use all --provider copilot
aiwg use all --provider warp
```

```bash
git add .claude/ .cursor/ .github/ .factory/ .aiwg/
git commit -m "feat: deploy AIWG framework to project"
git push
```

---

## What each teammate needs

> "I use Cursor and my teammate uses Copilot. What does each of us install and how do we verify the shared context?"

Your assistant tells each person which platform to install and how to verify the committed context from their own session.

Each person installs their own AI platform. They can start from the committed
provider files, then ask the agent to verify that the current session has read
the project context.

If they want to use the `aiwg` CLI for other tasks (deploying updates, adding agents, running the daemon), they install it individually:

### Command reference

```bash
npm install -g aiwg
```

---

## Keeping everyone in sync

> "AIWG released an update. Pull it, re-deploy to all providers, and tell me what to commit."

Your assistant pulls the latest framework, re-deploys to all providers, and lists the files to commit and push.

When AIWG releases updates or you add new agents and commands:

This pulls the latest framework and re-deploys to all providers. Commit and push, and everyone gets the update with the next `git pull`.

> `aiwg sync` is the deprecated alias and still works, but emits a warning and is scheduled for removal after the 2026.5.x stable line.

### Command reference

```bash
aiwg refresh
```

---

## Shared project context

> "Commit our .aiwg/ project artifacts so every teammate's AI session reads the same context."

Your assistant stages the reviewed artifacts and confirms what each teammate's session will read after the handoff.

The `.aiwg/` directory contains your project's artifacts — requirements, architecture decisions, test strategies. Commit it:

Now each teammate's AI session can read the same project context after its
provider handoff succeeds. A new engineer joining the team can open their AI
tool in the project and ask:

The answer should cite `.aiwg/` artifacts or repository files so the teammate
can see which context was used.

### Command reference

```bash
git add .aiwg/
git commit -m "docs: add project artifacts"
```

```
Explain this project to me as if I just joined the team
```

---

## Team-level conventions

> "Add a project-level rule that every teammate's AI tool will follow, and tell each of us how to verify it loaded."

Your assistant adds the rule through project setup or the provider rules directory and tells each teammate how to verify it in their own session.

AIWG rules are shared conventions. When you define a rule such as "avoid raw
SQL", "include error handling in API endpoints", or "require tests for new
functions", commit it with the provider files that should receive it.

To add a project-level rule:

Or edit the appropriate provider rules directory and commit it. Each teammate
should verify the rule is loaded in their own provider session.

**Agent-to-agent brief (example):**

```markdown
# Brief: roll out a team rule
Objective: add one project-level rule and confirm it loads in every teammate's provider session; nothing else.
Inputs: the rule text; the provider rules directories receiving it.
Acceptance: AC1 each teammate's session confirms the rule is loaded.
Limits: routine change, stop-and-report on conflicts.
Return: per-criterion confirmations plus the commit ref, or `partial` with omissions.
```

### Command reference

```
/aiwg-setup-project
```

---

## Onboarding new engineers

> "Onboard our new engineer. They cloned the repo and installed their AI platform — walk them through verification."

Your assistant runs the provider-handoff verification ask first, then the structured onboarding workflow for the engineer's role.

When someone new joins the team:

1. They clone the repo
2. They install their AI platform (Claude Code, Cursor, etc.)
3. They open the project in that platform

Then have them run the verification ask from [Provider Handoff](provider-handoff.md)
before depending on the context.

To give them a structured onboarding walkthrough:

This runs an orchestrated workflow that introduces the codebase, key decisions, and current state.

### Command reference

```
/flow-team-onboarding <name> --role <role>
```

---

## If your team uses GitHub Actions or CI

> "Run the AIWG security gate in CI before merge and show me where it is configured."

Your assistant adds the audit step to the workflow and points to the security gate reference for configuration.

You can run AIWG audits as part of CI — security gates, test coverage checks, quality gates before merge:

See the [security gate reference](https://github.com/jmagly/aiwg/blob/main/docs/cli/reference.md#security-gate) for configuration.

### Command reference

```yaml
# .github/workflows/quality.yml
- name: Security gate
  run: npx aiwg security-gate
```

---

## Multiple frameworks for different teams

> "Give the backend team SDLC and the marketing team the marketing framework, each verified from its own directory."

Your assistant deploys each framework from its own directory and verifies provider files, context, and first output per subteam.

Large orgs often have subteams with different needs — frontend, backend, DevOps, marketing. You can deploy different frameworks to different directories or branches:

Success means each subteam can verify its provider files, project context, and
first useful output from its own directory.

### Command reference

```bash
# Backend team
cd backend/
aiwg use sdlc

# Marketing team
cd marketing/
aiwg use marketing
```
