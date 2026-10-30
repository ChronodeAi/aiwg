# Connect AIWG to Muse Code

> **Status:** Stable.

For the complete first-time journey, start with [Install, Connect, and
Verify](../getting-started/install-connect-verify.md).

Muse Code is the **provider** in this guide — Meta's terminal/CI coding agent built on Muse Spark.
Complete the [safe Node.js setup](../getting-started/install-node.md) first if `node` or `npm` is
unavailable.

## 1. Install Muse Code

> "Check whether Muse Code is installed on this machine and ready for AIWG."

Your assistant confirms the `muse` binary is on your PATH.

Install [Muse Code](https://dev.meta.ai/docs/muse-code/) for your platform and confirm the `muse`
binary is on your PATH:

### Command reference
```bash
muse --version
```

## 2. Install AIWG and deploy

> "Install AIWG in this project and deploy it for Muse Code, then show me the verification result."

Your assistant installs AIWG and runs `aiwg use all --provider muse`, which refreshes AIWG's shared project context and prints a verification result.

From a terminal opened in the project's main folder, install AIWG and deploy the complete system:

### Command reference
```bash
npm install -g aiwg
aiwg use all --provider muse
```

The deployment command refreshes AIWG's shared project context and prints a verification result.

## 3. Trust the workspace, then start a new session

> "I trusted this workspace in Muse. Load the deployed bridge and skills and tell me what you can see."

Your assistant starts a new session so Muse loads the deployed bridge and skills from the trusted workspace.

> "I trusted the workspace but the AIWG skills are still missing — what now?"

Saying the skills are still missing points to the fix: start a new Muse session or re-read skills, since reloading an IDE window does not apply to this provider.

Muse Code loads project `AGENTS.md` only after the workspace is explicitly trusted. When Muse shows
the first-run trust prompt, **trust the workspace, then start a new Muse session** (or re-read
skills) so the deployed bridge and skills load. Reloading an IDE window does not apply here — this
provider is not Cursor.

## 4. Work discover-first

> "What AIWG skills and rules are available for this task before you start?"

Your assistant runs `aiwg discover` first and reads the deployed skill or rule before improvising.

Muse skills deploy natively to `<project>/.agents/skills/`; agents, commands, and rules stay
indexed. Before improvising, run:

### Command reference
```text
aiwg discover "<what you need>"
aiwg show <type> <name>
```

Then ask Muse Code to verify AIWG by reporting the project root, provider files it can read,
installed frameworks, and one useful next action.

Try one small task immediately after verification:

> "Review this project's README and getting-started docs for unclear positioning, missing setup steps, or unsupported claims. Save the three highest-priority fixes with file references and a recommended next edit at .aiwg/marketing/brand/audit/readme-review.md. Leave the reviewed files unchanged."

Your assistant follows the AIWG bootstrap into `WORKSPACE.md` and `AIWG.md` or the provider-specific adapter and produces a concrete review you can inspect.

Success means Muse Code names the intended project, follows the AIWG bootstrap into `WORKSPACE.md`
and `AIWG.md` or the provider-specific adapter, and produces a concrete review you can inspect.

## User-scope skills

> "Deploy AIWG skills for Muse Code across all my projects, not just this one."

Your assistant deploys user-level skills, resolved at deploy time, without touching other provider paths.

For user-level skills across projects:

### Command reference
```bash
aiwg use all --provider muse --scope user
```

Skills land in `$XDG_CONFIG_HOME/muse/skills` (default `~/.config/muse/skills`), resolved at deploy
time. AIWG never writes to `~/.muse`, foreign provider paths, or `~/.agents/skills`.

## Sessions

> "Share this Muse session's history with the operator."

Your assistant shares an explicit exported JSON document rather than assuming a native log location.

Session history is **export-first**: share an explicit `muse export` / `/export trajectory` JSON
document with the operator rather than assuming a native log root. AIWG never scrapes `~/.muse` or
similar homes for sessions.

For advanced flags, compatibility notes, and recovery details, see the [Muse Code operational
reference](https://github.com/jmagly/aiwg/blob/main/docs/agents/providers/muse.md).
