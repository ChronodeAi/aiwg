# Connect AIWG to Claude Code

For the complete first-time journey, start with [Install, Connect, and Verify](../getting-started/install-connect-verify.md).

Claude Code is the **provider** in this guide. Complete the [safe Node.js setup](../getting-started/install-node.md)
first if `node` or `npm` is unavailable.

## Connect, verify, and try a first task

> "Connect AIWG to Claude Code in this project, then verify it by reporting the project root, the provider files you can read, the installed frameworks, and one useful next action."

Your assistant installs AIWG and runs `aiwg use all --provider claude`, which refreshes AIWG's shared project context and prints a verification result.

> "The deploy output says a reload is required — what exactly do I reload before verifying?"

Naming the reload notice gets you the provider-specific reload step instead of a generic retry.

From a terminal opened in the project's main folder, install AIWG and deploy the complete system:

The deployment command refreshes AIWG's shared project context and prints a verification result. Close and reopen
Claude Code if the `aiwg use` output says a reload is required. After that, ask Claude Code to verify AIWG by reporting
the project root, provider files it can read, installed frameworks, and one useful next action.

### Command reference
```bash
npm install -g aiwg
aiwg use all --provider claude
```

Try one small task immediately after verification:

> "Review this project's README and getting-started docs for unclear positioning, missing setup steps, or unsupported claims. Save the three highest-priority fixes with file references and a recommended next edit at .aiwg/marketing/brand/audit/readme-review.md. Leave the reviewed files unchanged."

Your assistant follows the AIWG bootstrap into `WORKSPACE.md` and `AIWG.md` or the provider-specific adapter and produces a concrete review you can inspect.

Success means Claude Code names the intended project, follows the AIWG bootstrap into `WORKSPACE.md` and `AIWG.md` or
the provider-specific adapter, and produces a concrete review you can inspect. For advanced flags, compatibility
notes, and recovery details, see the [Claude operational
reference](https://github.com/jmagly/aiwg/blob/main/docs/agents/providers/claude.md).

## Keep commits and PRs free of attribution

Ask your assistant:

```text
Connect this project to Claude Code with AIWG's default no-attribution settings. Preserve my other Claude settings and any attribution I explicitly configured. Verify the resulting settings with aiwg doctor and explain any remaining attribution warning.
```

Claude deployments fill unset keys in `.claude/settings.json` with
`"attribution": { "commit": "", "pr": "", "sessionUrl": false }`. This disables
Claude's default commit and PR attribution reminders and session links. Existing
values are preserved; non-empty commit or PR values produce a warning. To disable
an explicit value, ask the assistant to clear that key in the settings file that
supplies it, then rerun doctor. Reload Claude Code after changing settings.

For machines where project settings are not committed, ask:

```text
Apply the same no-attribution defaults at user scope so they cover my other projects. Preserve any explicit values and show me which settings were added.
```

`--scope user` also merges the defaults into `~/.claude/settings.json`. AIWG records
only the keys it adds under the top-level `aiwg` block. Removing the last Claude
deployment or restoring the settings backup removes those keys while preserving
existing attribution and later operator edits. Unmarked settings files are backed
up before merging. `--no-hooks` still applies attribution defaults; use
`--no-attribution` to leave attribution untouched for that deployment. This opt-out
does not undo defaults from an earlier deployment.

Command reference:

```bash
aiwg use all --provider claude
aiwg use all --provider claude --scope user
aiwg use all --provider claude --no-attribution
aiwg doctor --provider claude
```

Doctor checks user, project, project-local and platform managed settings. Session
flags and server-managed policies are outside this offline check.
