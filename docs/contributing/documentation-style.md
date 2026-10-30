# Documentation style: prompt first

User guides lead with the expected agentic interaction. Each task section opens
with one to three example prompts a user would type to their assistant, written
as a blockquote with a blank line after every blockquote. Follow with one or
two sentences on what the assistant does in response, naming the real AIWG
behaviour. Where an agent briefs another agent, show the brief as a fenced
block labelled as a brief, then one refinement or recovery prompt.

Keep every existing command, flag, default, and limit exactly as written under
a "Command reference" heading. Never delete or reword a sentence of substance;
a moved sentence moves intact. Describe only behaviour AIWG ships, in plain
direct language. Keep headings other docs link to; report every rename.

## Good example

> "Hand the failing provider tests to Codex in its own worktree. Don't touch `src/models`. Bring back the test output."

Your assistant qualifies the installed CLIs, resolves a worker for the job, and
returns the result for your review before anything merges.

### Command reference

```bash
aiwg doctor --probe-workers --qualify
```
