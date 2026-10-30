# Connect AIWG to Cursor

For the complete first-time journey, start with [Install, Connect, and Verify](../getting-started/install-connect-verify.md).

Cursor is the **provider** in this guide. Complete the [safe Node.js setup](../getting-started/install-node.md) first
if `node` or `npm` is unavailable.

## Connect, verify, and try a first task

> "Connect AIWG to Cursor in this project, then verify it by reporting the project root, the provider files you can read, the installed frameworks, and one useful next action."

Your assistant installs AIWG and runs `aiwg use all --provider cursor`, which refreshes AIWG's shared project context and prints a verification result.

> "The deploy output says a reload is required — what exactly do I reload before verifying?"

Naming the reload notice gets you the provider-specific reload step instead of a generic retry.

From a terminal opened in the project's main folder, install AIWG and deploy the complete system:

The deployment command refreshes AIWG's shared project context and prints a verification result. Reload the Cursor
workspace if the `aiwg use` output says a reload is required. After that, ask Cursor to verify AIWG by reporting the
project root, provider files it can read, installed frameworks, and one useful next action.

### Command reference
```bash
npm install -g aiwg
aiwg use all --provider cursor
```

Try one small task immediately after verification:

> "Review this project's README and getting-started docs for unclear positioning, missing setup steps, or unsupported claims. Save the three highest-priority fixes with file references and a recommended next edit at .aiwg/marketing/brand/audit/readme-review.md. Leave the reviewed files unchanged."

Your assistant follows the AIWG bootstrap into `WORKSPACE.md` and `AIWG.md` or the provider-specific adapter and produces a concrete review you can inspect.

Success means Cursor names the intended project, follows the AIWG bootstrap into `WORKSPACE.md` and `AIWG.md` or the
provider-specific adapter, and produces a concrete review you can inspect. For advanced flags, compatibility notes,
and recovery details, see the [Cursor operational
reference](https://github.com/jmagly/aiwg/blob/main/docs/agents/providers/cursor.md).
