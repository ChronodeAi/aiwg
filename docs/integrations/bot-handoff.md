# Provider-neutral bot handoffs

`aiwg bot-handoff --provider <id> --input proposal.json` prints a reviewable
Markdown draft for routines, teammate profiles, connector recommendations or
memory references. It supports every provider in the shared registry, including
project-local registered definitions. Omit `--provider` to use normal active-provider
resolution; ambiguous or unknown selections fail with guidance. Use an explicit
provider in CI. It is opt-in and independent of baseline `aiwg use` deployment. The command reads
only the supplied proposal, never its referenced sources, and makes no product
API calls or filesystem writes. `--dry-run` produces the same draft.

For Grok Bot, these drafts are the interim scope for GitHub issues
[#241](https://github.com/jmagly/aiwg/issues/241),
[#242](https://github.com/jmagly/aiwg/issues/242),
[#243](https://github.com/jmagly/aiwg/issues/243) and
[#245](https://github.com/jmagly/aiwg/issues/245).
Native installation remains a separate contract-gated feature. Discarding a
draft disables the handoff; removing it does not undo objects an operator later
creates in the selected provider.

## Proposal format

Each invocation handles one surface. Supply only reviewed, non-secret text.
Unknown fields are rejected. The generator does not promise to detect secrets
embedded in otherwise valid summaries or file paths.

```json
{
  "surface": "routines",
  "name": "Weekly AIWG review",
  "summary": "Review current project issues and draft the next actions for the operator.",
  "references": ["aiwg show skill issue-audit"],
  "schedule": "Every Monday at 09:00",
  "timezone": "America/New_York"
}
```

`name` allows 100 characters and `summary` 280. Provide 1–10 references, each
at most 500 characters: file paths, HTTP(S) URLs without credentials, query
strings or fragments, or `aiwg show <agent|skill|command|rule> <name>` pointers.
References are proposal data, not commands the generator executes.

| Surface | Suggested proposal | Additional fields |
|---|---|---|
| `routines` | Schedule a reviewed workflow, with its owning Bot and approval boundary | `schedule` (up to 120 characters), `timezone` (IANA zone) |
| `teammates` | Describe the desired role; reference a curated AIWG agent using `aiwg show agent <name>` | None |
| `connectors` | Name the desired service and access scope; reference its official documentation | None |
| `memory` | Supply a short summary and current source pointers | None |

Schedules are natural-language proposals. The operator must verify how the provider
interprets the trigger and timezone before approving creation. A teammate draft
asks the provider to consult the referenced template; AIWG does not project a native
profile or overwrite an existing description.

## Review and export

```bash
aiwg bot-handoff --provider grokbot --input proposal.json --dry-run
```

Review stdout first. To retain a draft, resolve the canonical artifact store
with `aiwg artifacts path --json --check-write` and save beneath its returned
`artifact_root`. For example, in Bash with `jq` available:

```bash
set -euo pipefail
artifact_root=$(aiwg artifacts path --json --check-write | jq -er '.artifact_root')
: "${artifact_root:?Artifact store unavailable}"
mkdir -p "$artifact_root/working/bot-handoffs"
(set -o noclobber; aiwg bot-handoff --provider grokbot --input proposal.json > "$artifact_root/working/bot-handoffs/weekly-review.md")
```

An explicit operator-selected copy under `AIWG_GROKBOT_SKILLS_DIR` may serve as
a handoff export after the canonical draft is saved. A Markdown draft is not a
native plugin, skill installer or memory store. Review it before handing it to
the selected provider, and separately approve any resulting changes.

## Provider routing

The proposal format and command are shared. Guidance uses the existing provider
capability matrix: native features stay native; external scheduling stays with
the host scheduler or CI. When a capability is unsupported or unverified, the
output remains a prompt/configuration proposal, never an invented installer.
Memory references use the same conservative source-pointer policy everywhere.
Grok Bot's documented UI steps are confined to its guidance adapter.

```bash
aiwg bot-handoff --provider codex --input proposal.json
aiwg bot-handoff --provider claude --input proposal.json
aiwg bot-handoff --provider grok-build --input proposal.json
```

No new provider-specific public commands are needed to extend this support.
Native tool execution, authentication, configuration application and reload
remain provider responsibilities.

## Grok Bot product evidence

Verified against official documentation on 2026-09-20:

- [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations): ask a Bot to create routines; review and manage them in conversation details.
- [Create and manage Bots](https://docs.x.ai/grok-bot/bots): profile editing and template sharing are product operations; memory should point back to current sources.
- [Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps): connector installation uses Marketplace and operator authentication.
- [Team connector policy](https://docs.x.ai/grok-bot/teams-and-enterprises#connector-policy): permitted connectors remain subject to team policy; pushing them to members is unavailable.

For coding-agent jobs in CI, use [Grok Build CI setup](grok-build-ci.md) and
`--provider grok-build`. Grok Bot's optional native adapters are not prerequisites.
