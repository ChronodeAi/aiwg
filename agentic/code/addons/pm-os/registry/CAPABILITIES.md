# PM OS Capability Inventory

Generated from:

- `registry/commands.json`
- `registry/workflows.json`

Do not edit command/workflow facts here by hand. Update the registries, then run:

```bash
bash bin/generate-capability-inventory.sh
```

## Command Surfaces

| Command | Type | Owner | Cursor | Claude | Writes | Confirmation | Memory | Setup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /pm-os-agent-builder | core | core | `` | Claude: `/pm-os-agent-builder` | `true` | Requires confirmation: `true` | Memory: `none` | `false` |
| /pm-os-capture-memory | core | core | `` | Claude: `/pm-os-capture-memory` | `true` | Requires confirmation: `true` | Memory: `write` | `true` |
| /pm-os-daily-drip | core | core | `` | Claude: `/pm-os-daily-drip` | `true` | Requires confirmation: `true` | Memory: `state` | `true` |
| /pm-os-feedback | core | core | `` | Claude: `/pm-os-feedback` | `false` | Requires confirmation: `true` | Memory: `none` | `false` |
| /pm-os-framework | core | core | `` | Claude: `/pm-os-framework` | `false` | Requires confirmation: `false` | Memory: `none` | `true` |
| /help | core | core | `` | Claude: `/pm-help` | `false` | Requires confirmation: `false` | Memory: `none` | `false` |
| /import-ai-memory | core | core | `` | Claude: `/import-ai-memory` | `true` | Requires confirmation: `true` | Memory: `context` | `false` |
| /pm-os-upgrade | core | core | `` | Claude: `/pm-os-upgrade` | `true` | Requires confirmation: `true` | Memory: `preserve` | `false` |
| /pm-os-project | core | core | `` | Claude: `/pm-os-project` | `true` | Requires confirmation: `true` | Memory: `state` | `true` |
| /pm-os-skill | core | core | `` | Claude: `/pm-os-skill` | `false` | Requires confirmation: `false` | Memory: `none` | `true` |
| /skill-browser | core | core | `` | Claude: `/skill-browser` | `false` | Requires confirmation: `false` | Memory: `none` | `false` |
| /pm-os-start | core | core | `` | Claude: `/pm-os-start` | `true` | Requires confirmation: `true` | Memory: `context` | `false` |
| /status | core | core | `` | Claude: `/pm-status` | `false` | Requires confirmation: `false` | Memory: `read` | `true` |
| /pm-os-testimonial | core | core | `` | Claude: `/pm-os-testimonial` | `false` | Requires confirmation: `true` | Memory: `none` | `false` |
| /pm-os-tidy | core | core | `` | Claude: `/pm-os-tidy` | `true` | Requires confirmation: `true` | Memory: `context_sync` | `true` |
| /assumptions | workflow | pm-workflows | `` | Claude: `/assumptions` | `true` | Requires confirmation: `true` | Memory: `read` | `true` |
| /coaching | workflow | pm-workflows | `` | Claude: `/coaching` | `true` | Requires confirmation: `true` | Memory: `none` | `true` |
| /decisions | workflow | pm-workflows | `` | Claude: `/decisions` | `true` | Requires confirmation: `true` | Memory: `read` | `true` |
| /measure | workflow | pm-workflows | `` | Claude: `/measure` | `true` | Requires confirmation: `true` | Memory: `read` | `true` |
| /meeting | workflow | pm-workflows | `` | Claude: `/meeting` | `true` | Requires confirmation: `true` | Memory: `read` | `true` |
| /opportunity | workflow | pm-workflows | `` | Claude: `/opportunity` | `true` | Requires confirmation: `true` | Memory: `read` | `true` |
| /research | workflow | pm-workflows | `` | Claude: `/research` | `true` | Requires confirmation: `true` | Memory: `read` | `true` |
| /prd | workflow | pm-workflows | `` | Claude: `/prd` | `true` | Requires confirmation: `true` | Memory: `read` | `true` |
| /review | workflow | pm-workflows | `` | Claude: `/pm-review` | `true` | Requires confirmation: `true` | Memory: `read` | `true` |
| /stakeholder | workflow | pm-workflows | `` | Claude: `/stakeholder` | `true` | Requires confirmation: `true` | Memory: `read` | `true` |
| /strategy | workflow | pm-workflows | `` | Claude: `/strategy` | `true` | Requires confirmation: `true` | Memory: `read` | `true` |

## Workflow Contracts

| Workflow | Command | File | Output | Memory preflight | Checkpoint | Skills | Subagents |
| --- | --- | --- | --- | --- | --- | --- | --- |
| assumption-mapping | /assumptions | `skills/assumptions/SKILL.md` | Output: `project` | `required` | Checkpoint: `linear_no_resume_yet` | 4 | 0 |
| core-strategy-development | /strategy | `skills/strategy/SKILL.md` | Output: `project` | `required` | Checkpoint: `linear_no_resume_yet` | 6 | 0 |
| make-great-decisions | /decisions | `skills/decisions/SKILL.md` | Output: `project` | `required` | Checkpoint: `linear_no_resume_yet` | 7 | 0 |
| measure-what-matters | /measure | `skills/measure/SKILL.md` | Output: `project` | `required` | Checkpoint: `linear_no_resume_yet` | 5 | 0 |
| meeting-mastery | /meeting | `skills/meeting/SKILL.md` | Output: `project` | `required` | Checkpoint: `linear_no_resume_yet` | 4 | 0 |
| multi-perspective-review | /review | `skills/pm-review/SKILL.md` | Output: `project_or_reviews` | `required` | Checkpoint: `linear_no_resume_yet` | 2 | 7 |
| opportunity-mapping | /opportunity | `skills/opportunity/SKILL.md` | Output: `project` | `required` | Checkpoint: `linear_no_resume_yet` | 5 | 0 |
| pm-coaching | /coaching | `skills/coaching/SKILL.md` | Output: `coaching` | `not_applicable` | Checkpoint: `linear_no_resume_yet` | 6 | 0 |
| research-to-feature | /research | `skills/research/SKILL.md` | Output: `project` | `required` | Checkpoint: `linear_no_resume_yet` | 6 | 0 |
| stakeholder-copilot | /stakeholder | `skills/stakeholder/SKILL.md` | Output: `project` | `required` | Checkpoint: `linear_no_resume_yet` | 8 | 0 |
| prd-construction | /prd | `skills/prd/SKILL.md` | Output: `project` | `required` | Checkpoint: `linear_no_resume_yet` | 9 | 9 |
