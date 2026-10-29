# Bringing AIWG into an Existing Project

> **First time using AIWG?** Begin with [Install, Connect, and Verify](install-connect-verify.md). This guide assumes
AIWG is connected to the target project and your provider session can read the deployed context.

You already have a codebase. Maybe it's yours, maybe you inherited it. Either way, you want an AI assistant that actually understands what's in there — not one that has to be reminded every session what the project does and how it's structured.

This guide gets AIWG oriented around the code you already have.

Each section starts with what you can ask your assistant, then gives the command reference.

---

## Step 1 — Open the project folder

> "Help me set up this project for AIWG from this folder. Establish how this repo works and what I should check."

Your assistant opens the guided setup conversation to establish remotes, issue storage, delivery behavior, and policy, without asking you to map fields by hand.

> "You named the wrong delivery policy. Re-check the repo remotes and state the evidence."

If AIWG is not connected yet, complete [Install, Connect, and Verify](install-connect-verify.md)
from this folder before starting the codebase intake.

Ask your AI assistant to set up AIWG for this repository:

```
Help me set up this project for AIWG.
```

The setup conversation should establish how this repository actually works:
which remotes matter, where issues live, whether delivery is direct-to-main or
branch/PR based, what commit and signing policy applies, which providers should
be enabled, and whether `.aiwg/issues/` should be used for local issue storage.

The assistant may call `aiwg setup project --dry-run` or
`aiwg setup project --yes` while working with you, but the important surface is
the guided conversation. You should not have to map repo policy fields by hand.

### Command reference

```bash
cd /path/to/your/project
```

```bash
aiwg setup project --dry-run
aiwg setup project --yes
```

---

## Step 2 — Let the AI read the codebase

> "Run the codebase intake scan and generate the project intake document in .aiwg/intake/."

Your assistant scans directories, key files, tests, and configs, then generates the intake document — no questions or forms needed.

> "The intake missed the test gaps. Re-scan and list what tests exist and what's missing."

In your provider session, run the codebase intake scan:

This scans your project — directory structure, key files, existing tests, README, package.json, config files — and generates a project intake document in `.aiwg/intake/`. It figures out:

- What the project does
- What tech stack it uses
- What the existing architecture looks like
- What tests exist (and what's missing)

You don't have to answer questions or fill out forms. It reads the code.

### Command reference

```
/intake-from-codebase
```

---

## Step 3 — Review what it found

> "What did you learn about this project? List anything you are unsure about before I correct it."

Your assistant summarizes the intake findings and flags uncertainties, since this document drives everything else.

The intake document lands at `.aiwg/intake/`. Read it and correct anything that's wrong:

```
What did you learn about this project?
```

Or open `.aiwg/intake/project-intake.md` directly and edit it. This document drives everything else — fix inaccuracies now.

---

## Step 4 — Set up project context

> "Wire the intake into the provider configuration so future sessions load the right background."

Your assistant wires the intake into the provider configuration so the AI keeps persistent context across sessions.

After the repo policy setup and intake scan, ask the assistant to wire the
project context so future sessions load the right background:

This wires the intake into the provider configuration so the AI has persistent
context across sessions. It complements the earlier setup conversation about
remotes, issue storage, delivery behavior, and policy.

### Command reference

```
/aiwg-setup-project
```

---

## Now the AI knows your project

> "What are the riskiest parts of this codebase? Cite the project files you relied on."

Your assistant answers from the corrected intake and cites the project files and decisions relied on.

> "That answer cited nothing. Re-answer citing the project files and decisions you relied on."

Ask it anything:

```
What are the riskiest parts of this codebase?
```

```
Find functions with no test coverage
```

```
Where does the authentication flow start and what does it do?
```

```
What would break first if we changed the user model?
```

```
Summarize the architecture for a new engineer joining the team
```

The useful outcome is a corrected intake artifact plus answers that cite the
project files and decisions they rely on. If the agent cannot cite the project
or names the wrong folder, return to [Scope and Recovery](scope-and-recovery.md).

---

## If the project has no documentation

> "Write architecture documentation based on what you've read, and tell me where it lands."

Your assistant generates the docs into `.aiwg/` so they can be committed as part of the project.

That's a common situation. AIWG can generate it:

```
Write architecture documentation based on what you've read
```

```
Create a README from what you know about this project
```

```
Generate use cases from the existing code
```

The resulting docs go into `.aiwg/` and can be committed as part of the project.

---

## If you inherited code you don't fully understand

> "Explain this codebase to me as if I just joined the team today, then walk me through the login flow."

Your assistant explains the codebase for a new joiner and digs into the named area with file evidence.

This is exactly what AIWG is built for. Run:

```
Explain this codebase to me as if I just joined the team today
```

Then dig into specific areas:

```
What does the billing module do and how does it connect to the rest of the system?
```

```
Walk me through what happens when a user logs in
```

```
Which parts of this code look like technical debt?
```

---

## Ongoing use

> "Where are we and what's next?"

Your assistant reports project status from the loaded context, iterating until the measurable check passes and running reviews as quality gates.

> "Fix all failing tests; keep iterating until `npm test` passes. Then run a security review on this branch."

Once the project is loaded, AIWG is most useful in your normal workflow:

- Ask the agent for project status at the start of each session ("where are we?", "what's next?")
- For iterative tasks, ask the agent to keep working until a measurable check passes ("fix all failing tests; keep iterating until `npm test` passes")
- Ask for a security review periodically as a quality gate ("run a security review on this branch")

The agent invokes the underlying AIWG workflows — `/project-status`, agent loops, `/flow-security-review-cycle` — from inside the conversation. You stay in chat.

See [New Project](new-project.md) for a full description of the SDLC workflow once you're oriented.

### Command reference

```
/project-status
```

```
/flow-security-review-cycle
```
