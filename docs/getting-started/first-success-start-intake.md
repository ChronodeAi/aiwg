# First Success: Start A Project Intake

> **First time using AIWG?** Begin with [Install, Connect, and Verify](install-connect-verify.md). This guide assumes
AIWG is connected to the target project and your provider session can read the deployed context.

Use this recipe when you have an idea, repo, or workstream and want AIWG to turn it into structured project context. Each section starts with what you can ask your assistant, then gives the command reference.

## Do This

> "Help me start an AIWG intake for this project. Recommend one intake path and ask only the questions needed to begin."

> "I'm not sure which intake path fits. Pick between intake-wizard and intake-from-codebase based on what's already in this folder, and start the one you recommend."

Your assistant inspects the project files, recommends one intake path, and starts it with only the questions needed to begin.

Go to the project folder:

Ask the agent:

For a new software project, use:

For an existing codebase, use:

If you do not know which intake variant fits, describe the situation in plain words and ask the agent to choose:

The agent inspects the project files and selects the right intake.

### Command reference

```bash
cd /path/to/your/project
```

```text
Help me start an AIWG intake for this project. Recommend one intake path and ask only the questions needed to begin.
```

```text
/intake-wizard "<short project description>"
```

```text
/intake-from-codebase .
```

```text
I'm not sure which intake path fits. Pick between intake-wizard and
intake-from-codebase based on what's already in this folder, and start
the one you recommend.
```

## You Should See

> "Summarize the intake draft and list what is still missing before you write anything to .aiwg/."

Your assistant reports whether it has enough context to produce or update intake documents, or names the specific blocker.

The agent has enough context to produce or update intake documents, or it has given you a specific blocker such as missing project files or an unavailable provider command.

Refinement prompt:

> "You listed a blocker. Tell me the exact file or command that is missing and what to do next."

Your assistant names the missing file or unavailable command and the next step.

## If That Did Not Work

> "This intake seems scoped to the wrong folder. Re-check the project root and restart from the files in the current directory."

Your assistant checks scope with `pwd`, the folder listing, and `aiwg status --probe --json`, then tells you whether to move before deploying.

If the agent describes the wrong project, stop and check scope:

Then ask:

### Command reference

```bash
pwd
ls -a
```

```text
This intake seems scoped to the wrong folder. Re-check the project root and restart from the files in the current directory.
```

## Next

Once intake starts, follow [Getting Started with Intake](../intake-guide.md) for the command that matches your project.

## Related

- [Start Here](start-here.md)
- [Intake Guide](../intake-guide.md)
