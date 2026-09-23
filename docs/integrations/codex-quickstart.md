# Connect AIWG to OpenAI Codex

For the complete first-time journey, start with [Install, Connect, and Verify](../getting-started/install-connect-verify.md).

OpenAI Codex is the **provider** in this guide. Complete the [safe Node.js setup](../getting-started/install-node.md)
first if `node` or `npm` is unavailable.

From a terminal opened in the project's main folder, install AIWG and deploy the complete system:

```bash
npm install -g aiwg
aiwg use all --provider codex
```

The deployment command refreshes AIWG's shared project context and prints a verification result. A running Codex
session picks up newly deployed skills on the next turn — no restart is needed to start using them. Reopen Codex in
this workspace only as a fallback, if a deployed skill or agent is still missing after that next turn. Custom agent
registry and MCP server changes have not been verified to refresh live, so reopening remains the reliable route for
those. After that, ask OpenAI Codex to verify AIWG by reporting the project root, provider files it can read,
installed frameworks, and one useful next action.

Try one small task immediately after verification:

```text
Review this project's README and getting-started docs for unclear positioning, missing setup steps, or unsupported claims. Save the three highest-priority fixes with file references and a recommended next edit at .aiwg/marketing/brand/audit/readme-review.md. Leave the reviewed files unchanged.
```

Success means OpenAI Codex names the intended project, follows the AIWG bootstrap into `WORKSPACE.md` and `AIWG.md` or
the provider-specific adapter, and produces a concrete review you can inspect. For advanced flags, compatibility
notes, and recovery details, see the [Codex operational
reference](https://github.com/jmagly/aiwg/blob/main/docs/agents/providers/codex.md).
