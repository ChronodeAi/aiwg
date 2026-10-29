# Starting a New Project

> **First time using AIWG?** Begin with [Install, Connect, and Verify](install-connect-verify.md). This guide assumes
AIWG is connected to the target project and your provider session can read the deployed context.

You have an idea. You want to build something. AIWG runs a structured intake conversation, generates the foundation documents your project needs, then assigns AI agents to carry the work forward.

The first useful output is a project intake you can inspect and correct:
problem statement, users, constraints, risks, and next action.

Each section starts with what you can ask your assistant, then gives the command reference.

---

## Step 1 — Create your project folder

> "Create a new project folder with git, connect AIWG here, and report the project root, provider, deployed context, and one next action."

Your assistant creates the folder, initializes version control, and reports the project root, provider, deployed context, and one next action.

> "AIWG is not connected here yet. Tell me which verify step failed and what to run from this folder."

If AIWG is not connected to this new folder yet, complete
[Install, Connect, and Verify](install-connect-verify.md) here. Continue after
the agent reports the project root, provider, deployed context, and one next
action.

### Command reference

```bash
mkdir my-project && cd my-project
git init
```

---

## Step 2 — Start intake

> "I want to build a REST API for a task management app with team assignments and notifications. Start the intake and ask me only what you need."

Your assistant runs the structured intake conversation, asks clarifying questions, and generates the intake form, use cases, architecture sketch, and risk register under `.aiwg/`.

> "That assumption is wrong. Correct it and regenerate the affected intake artifact."

Tell the provider session what you're building:

```
I want to build a REST API for a task management app. Users can create tasks,
assign them to teammates, and get notifications when tasks are due.
```

Or use the explicit intake command:

The AI will ask clarifying questions, then generate:

- **Intake form** — problem statement, users, goals, constraints
- **Use cases** — what the system does, who it does it for
- **Architecture sketch** — components, tech stack recommendations
- **Risk register** — what could go wrong early

These go into `.aiwg/` in your project. You can read them, edit them, and they guide everything that comes next.

---

Success means the generated intake artifacts exist under `.aiwg/`, the agent
can summarize them back to you, and you have corrected any wrong assumptions.

### Command reference

```
/intake-wizard "task management API with team assignments and notifications"
```

## Step 3 — Start building

> "Create the user model based on the requirements."

Your assistant builds in context — it knows your architecture, your requirements, and what decisions have already been made.

> "That ignored the intake constraints. Re-do it citing the requirement you used."

Once intake is complete, the AI knows your project. You can now use natural language to drive development:

```
Create the user model based on the requirements
```

```
Write unit tests for the task assignment feature
```

```
Run a security review on the authentication flow
```

```
What phase are we in and what's next?
```

The AI will answer in context — it knows your architecture, your requirements, and what decisions have already been made.

---

## What the `.aiwg/` folder contains

> "Show me what the .aiwg/ folder holds and which artifact drives the next step."

Your assistant lists the generated artifacts and names the one that guides what comes next.

Everything generated during the project lives here:

```
.aiwg/
├── intake/         ← Your project definition
├── requirements/   ← Use cases and user stories
├── architecture/   ← Architecture decisions (ADRs)
├── testing/        ← Test strategy and plans
├── security/       ← Threat model
├── planning/       ← Phase plans, iteration notes
└── reports/        ← Status and audit reports
```

You can commit this folder. It becomes part of your project history. New team members can read it to understand the project, and new AI sessions can load it to pick up context.

---

## Moving through phases

> "Move us to elaboration. Run the gate check and tell me what needs to be done."

Your assistant runs the gate check, verifies what needs to be done, and orchestrates the transition.

> "The gate check failed. Tell me what needs to be done before we can transition."

AIWG uses a structured lifecycle: Inception → Elaboration → Construction → Transition.

To move between phases, just say so:

```
Let's move to elaboration
```

```
Transition to construction — we're done with design
```

The AI will run a gate check, verify what needs to be done, and orchestrate the transition.

---

## If you already have some code

> "This folder already has code. Scan it and fill in the intake from the code instead of asking from scratch."

Your assistant scans what you have and fills in the intake from the code rather than asking you from scratch.

Run `/intake-from-codebase` instead of `/intake-wizard` — it scans what you have and fills in the intake from the code rather than asking you from scratch. See [Existing Project](existing-project.md).

### Command reference

```
/intake-from-codebase
```
