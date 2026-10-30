# Connect AIWG to Pi Coding Agent

> Upstream baseline: Pi Coding Agent 0.85.0, commit
> [`47236c84450656043dd8fb21c8513d1421505ae3`](https://github.com/earendil-works/pi/commit/47236c84450656043dd8fb21c8513d1421505ae3),
> verified 2026-09-04.

Pi Coding Agent is the minimal agent harness published at
[pi.dev](https://pi.dev/). AIWG's `pi` provider targets that harness directly;
`pi.dev` is not a separate provider ID.

Pi is an experimental AIWG deployment provider. AIWG installs declarative
context, skills, prompt templates, and a reviewed trust-gated policy extension;
it does not install Pi packages or credentials. Start with [Install, Connect, and
Verify](../getting-started/install-connect-verify.md) for the general AIWG
setup journey.

## Install, preview, and deploy

> "Install AIWG in this project for the Pi Coding Agent, preview the deployment, then deploy it."

Your assistant previews with `aiwg use all --provider pi --dry-run`, then deploys, which refreshes AIWG's shared project context and prints a verification result.

> "How do I pick the model backend for Pi itself, separately from the AIWG integration?"

Naming the backend question points to Pi's own `--provider` option and model flags, which select the LLM backend — distinct from AIWG's `--provider pi`.

Pi 0.85.0 requires Node.js 22.19 or newer and is published as
[`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json).

### Command reference
```bash
npm install -g @earendil-works/pi-coding-agent
npm install -g aiwg
cd /path/to/project

aiwg use all --provider pi --dry-run
aiwg use all --provider pi
```

The deployment command refreshes AIWG's shared project context and prints a
verification result. Follow any reload notice in that output before starting a
Pi session.

Here, AIWG's `--provider pi` selects the **coding-agent integration**. It is
not Pi's own `--provider` option, which selects an LLM backend such as
OpenRouter. Pi documents its model flags in the [coding-agent
README](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#providers--models).

## Trust and verification

> "Trust this project in Pi and verify that AIWG is loaded."

Your assistant approves the project trust, restarts, and checks AIWG with `aiwg doctor --provider pi` and `aiwg steward capabilities --provider pi`.

> "I want to run Pi non-interactively in automation — how should approval be handled?"

Stating the non-interactive mode gets the explicit choice: every automated invocation must choose between `--approve` and `--no-approve`.

Project-local settings, extensions, skills, and prompts are trust-gated;
context files such as `AGENTS.md` load independently of that decision. In
interactive Pi, run `/trust` and restart after approving the project.
Non-interactive modes do not show the trust dialog, so every automated
invocation must choose explicitly between `--approve` and `--no-approve`;
see Pi's [project trust
documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md#project-trust).

### Command reference
```bash
pi
# In Pi: /trust, approve, then restart

aiwg doctor --provider pi
aiwg steward capabilities --provider pi
```

Try one small task immediately after trust and verification:

> "Review this project's README and getting-started docs for unclear positioning, missing setup steps, or unsupported claims. Return the three highest-priority fixes with file references and a recommended next edit."

Your assistant loads `AGENTS.md` and the trusted AIWG project resources and produces a concrete review you can inspect.

Success means Pi names the intended project, loads `AGENTS.md` and the trusted
AIWG project resources, and produces a concrete review you can inspect.

For a bounded, non-interactive check that loads trusted project resources:

### Command reference
```bash
PI_CODING_AGENT_SESSION_DIR="$(mktemp -d)" \
  pi --approve --mode json -p "List the AIWG skills available in this project"
```

This may call the selected model and consume tokens. Use `--no-approve` when
testing without project-local resources.

## Installed resources

| Resource | Location | Purpose |
|---|---|---|
| Project context | `AGENTS.md` | Directs Pi to `WORKSPACE.md` and `AIWG.md` |
| Portable skills and roles | `.agents/skills/*/SKILL.md` | Pi's shared Agent Skills surface |
| AIWG-managed skills | `.pi/.aiwg/skills/` | Receipted AIWG projection |
| Prompt templates | `.pi/prompts/*.md` | User-facing AIWG commands |
| Policy bridge | `.pi/extensions/aiwg-bridge.ts` | Fail-closed headless command policy |

Pi discovers project skills in `.pi/skills/` and `.agents/skills/`, as
documented in [Skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md).
Prompt templates live in `.pi/prompts/`; AIWG flattens generated prompt names
because Pi's [prompt-template
discovery](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/prompt-templates.md)
is non-recursive.

## Refresh and remove

> "Refresh the Pi deployment and show me what is installed. If I remove a framework, what stays behind?"

Your assistant refreshes with `aiwg refresh --provider pi`, lists installed items, and removes only receipted files, preserving operator-owned settings, prompts, skills, extensions, packages, sessions, and trust decisions.

### Command reference
```bash
aiwg refresh --provider pi --dry-run
aiwg refresh --provider pi
aiwg list
aiwg remove <installed-framework-or-addon> --dry-run
aiwg remove <installed-framework-or-addon>
```

`aiwg remove` operates on an installed framework or addon, not on a provider
alone. Repeat it for each installed item you intend to remove. AIWG only removes
receipted files and preserves operator-owned `.pi/settings.json`, prompts,
skills, extensions, packages, sessions, and Pi's trust decisions.

For user scope, session handling, OpenRouter examples, limitations, and
troubleshooting, see the [Pi operational
reference](https://github.com/jmagly/aiwg/blob/main/docs/agents/providers/pi.md).

External Ralph can launch Pi with `--provider pi`; pass a Pi-native
`provider/model` identifier using `--model`, and optionally `--thinking` and
`--tools`. Session ingestion supports authorized Pi v3 JSONL roots; see
[Pi session acquisition](../providers/pi-sessions.md).
