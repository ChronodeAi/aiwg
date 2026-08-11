# PM Workflows Registry

This directory is the machine-readable inventory and validation contract for PM OS command and workflow wiring.

It is not the behavioral source of truth by itself. The source of truth is split:

- Human-authored behavior: `skills/*/SKILL.md` and `agents/*.md`
- Machine-readable contract: `registry/*.json`
- Generated surfaces: provider adapters under `.codex/`, `.cursor/`, and `.claude/`
- Enforcement: workflow/agent/skill validators plus `bin/validate-codex-parity.sh`

## Files

- `commands.json` lists every core and workflow command, including owner plugin, canonical file, Cursor stub, Claude skill, argument hint, write behavior, setup requirement, and memory behavior.
- `workflows.json` lists the 11 PM workflows, including command slug, canonical file, skill references, output destination, memory preflight policy, checkpoint policy, and subagent references.
- `CAPABILITIES.md` is the generated human-readable inventory. Regenerate it from the JSON registries; do not hand-edit facts in it.
- `skills.json` lists every `skills/*/SKILL.md` file with stable skill ID, slug, name, description, path, provenance, and status.
- `SKILLS.md` is the generated human-readable skill inventory.
- `agents.json` lists active subagents, canonical files, provider mirrors, read/write policy, and workflow usage.
- `agent-classification.md` documents why other agent-like surfaces are routers, skills, or deferred.

## Update Rule

Any change to command files, workflow files, skill references, generated stubs, memory I/O, output destinations, or subagent references must update this registry in the same change.

Any change to `skills/*/SKILL.md` or `external-skills/registry.json` must regenerate and validate the skill registry.

Run:

```bash
bash bin/validate-workflow-registry.sh
bash bin/generate-capability-inventory.sh --check
bash bin/generate-skill-registry.sh --check
bash bin/validate-skill-registry.sh
bash bin/validate-agent-registry.sh
```

The registry is useful only because validation proves it still matches the implementation. Provider adapters are generated views; the Markdown skills and registries remain canonical.

## Not Yet In Scope

- Workflow checkpoint/resume state (`linear_no_resume_yet` remains the truthful policy).
- Publishing a universal OpenAI plugin package; the current delivery target is the AIWG addon.
Subagent execution is limited to the agents declared in `agents.json`; broader subagent creation remains out of scope unless added to the registry.

Those build on this contract later.
