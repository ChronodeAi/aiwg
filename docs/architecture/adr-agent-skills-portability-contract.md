# ADR: Agent Skills portability contract

Status: accepted
Date: 2026-07-26
Decision owners: AIWG maintainers
Related: #539, #546, #547, #1046, #1553, #1569, #1875, #1877, #1878,
#1879, #1880, #1881

## Context

AIWG skills carry routing, provider, execution, orchestration, and ownership
metadata beyond the portable Agent Skills format. Emitting that metadata as
portable frontmatter fails strict consumers; dropping it makes an AIWG round
trip lossy. Import and provider deployment therefore need a typed boundary
between portable content and AIWG control policy.

The upstream contract is pinned to
`agentskills/agentskills@38a2ff82958afee88dadf4831509e6f7e9d8ef4e`
(2026-07-09), with `skills-ref` version `0.1.0` used only as a fixture oracle.
The upstream repository currently defines a directory format, not an official
agentskills.io registry protocol.

The website specifies ASCII lowercase skill names while the pinned reference
validator accepts lowercase Unicode alphanumeric characters. AIWG chooses the
narrower ASCII rule until upstream resolves the ambiguity:
`^[a-z0-9]+(?:-[a-z0-9]+)*$`, 1-64 characters, matching the parent directory.

## Decision

### Validation profiles

| Profile | Accepted input | Unknown fields | Recoverable name defects |
|---|---|---|---|
| `strict` | Normative Agent Skills fields only | Error | Error |
| `compatible` | Standard fields plus the recognized AIWG fields below | Error and retained as diagnostic evidence | Error |
| `discovery` | Parseable discovery metadata | Warning and retained as diagnostic evidence | Warning; missing description or unreadable YAML still skips the skill |

All profiles use AIWG's YAML parser so existing flow sequences remain readable.
Profile rules run after parsing. The 500-line and 5,000-token recommendations,
relative references, and one-level reference depth are advisory diagnostics,
not compatibility failures.

`namespace` and `platforms` are AIWG control extensions. Canonical AIWG source
policy may require them, but the Agent Skills standard does not. They are
accepted by `compatible` and `discovery`, rejected by `strict`, and retained in
the sidecar rather than projected as portable fields.

### Typed representation

`src/skills/agent-skills.ts` defines the intermediate representation:

- `standard` contains every portable field;
- `body` retains Markdown independently of frontmatter;
- `resources` records every accepted regular resource path, size, and digest;
- `aiwg` contains only recognized AIWG control fields;
- optional `providers.claude` retains the recognized native Claude fields;
- `unknownFields` retains external fields as diagnostic data without granting
  them AIWG policy meaning.

Exact source bytes remain in the immutable managed source tree. The parsed
representation is not a replacement for those bytes.

Issue #3703 extends the existing v1 sidecar with optional `providers.claude`.
Compatible validation recognizes the Claude field set without widening the
six-field portable baseline. Claude deployment restores the native fields;
other managed provider projections drop them with field/provider warnings and
`degraded` status. Strict export retains the values only in its sidecar.
See [the field and surface projection tables](../skills/agent-skills.md#strict-provider-projection).

#### D1/D2 source investigation (#3703)

The portable allow-list is `src/skills/agent-skills.ts:24`; unknown fields are
diagnosed at `src/skills/agent-skills.ts:385`. Contrary to the brief's example,
this checkout already recognized `context` and `effort` as legacy AIWG fields
(`src/skills/agent-skills.ts:114`), so their defect was silent loss during
projection. Other native spellings, such as `user-invocable`, were unknown.
Strict rejection of recognized extensions is in `src/skills/validator.ts:136`.

`src/skills/deployer.ts:113` now delegates its former six-field-only projection
to `src/skills/deployment-projection.ts:104`. The existing ownership/provenance
sidecar is still `.aiwg-agent-skill.json`; provider values are copied and
restored by `src/skills/agent-skill-sidecar.ts:8`, using the existing schema's
optional `providers` property (`schemas/skills/agent-skill-sidecar.v1.schema.json:25`).

Separate bundled provider deployers also consume frontmatter: the shared copier
at `tools/agents/providers/base.mjs:1577` injects platforms and calls provider
transforms; Claude's `tools/agents/providers/claude.mjs:346` compiles
`commandHint` model/effort; Factory's `tools/agents/providers/factory.mjs:417`
maps and filters native fields; Hermes's `tools/agents/providers/hermes.mjs:155`
rewrites platforms and Hermes tags; `tools/skills/deploy-skills-codex.mjs:233`
parses metadata before its Codex rendering. Managed import deployment uses
`src/skills/deployer.ts`, independently of those bundled-source transformers.

### Standard field map

| Agent Skills field | Internal representation | Strict projection |
|---|---|---|
| `name` | `standard.name` | Direct |
| `description` | `standard.description` | Direct |
| `license` | `standard.license` | Direct, including resource references |
| `compatibility` | `standard.compatibility` | Direct |
| `metadata` | `standard.metadata` as string-to-string | Direct |
| `allowed-tools` | `standard["allowed-tools"]` | Direct; experimental upstream |

No standard field is truncated, discarded, or moved to the AIWG sidecar.

### AIWG field map

These are the current canonical frontmatter fields and in-memory skill control
fields. They are retained under `sidecar.aiwg` and never emitted as strict
top-level keys.

| Category | AIWG fields |
|---|---|
| Identity and compatibility | `namespace`, `aliases`, `deprecated_names`, `legacyName`, `version`, `author`, `status` |
| Provider and discovery | `platforms`, `triggers`, `triggerPhrases`, `autoTrigger`, `autoTriggerConditions`, `kernel`, `category`, `capabilities` |
| Execution contract | `requires`, `ensures`, `errors`, `invariants`, `tools`, `script`, `references`, `inputRequirements`, `outputFormat` |
| Invocation policy | `userInvocable`, `disableModelInvocation`, `context`, `effort`, `allowedTools` |
| Command/orchestration policy | `commandHint` |

`allowed-tools` and AIWG `allowedTools` both express direct pre-approval and may
be translated when `allowedTools` is a list of non-empty, whitespace-free tool
identifiers. `commandHint.allowedTools` describes generated command access; its
semantics are not equivalent and it is never promoted to portable
`allowed-tools`.

### Sidecar and managed layout

The versioned sidecar conforms to
`schemas/skills/agent-skill-sidecar.v1.schema.json`. It records:

- recognized AIWG metadata omitted from strict `SKILL.md`;
- source kind and locator;
- requested and resolved Git revisions where applicable;
- SHA-256 source digest;
- import time and AIWG version;
- validation profile;
- trust and activation state.

Imported source is stored at `.aiwg/skills/imported/<name>/source/`. Its
`manifest.json` is the sibling
`.aiwg/skills/imported/<name>/manifest.json`, outside the byte-preserved source
directory.

Provider deployment writes `.aiwg-agent-skill.json`. This deployment wrapper
records provider/path projection state and embeds the portable sidecar contract
under `portable`. The exact `.aiwg-managed` marker establishes ownership.
Both files remain separate from portable frontmatter.

### Import sources and update behavior

Version 1 accepts:

1. a local directory whose root contains `SKILL.md`;
2. a Git URL, explicit revision, and skill subpath.

Unpinned Git requests are invalid. Import stages and validates before promotion.
The content digest covers sorted normalized relative paths, file sizes, and
bytes for every accepted regular file. Identical source/revision/digest imports
are idempotent. A changed revision or digest requires an explicit update;
`force` never authorizes overwriting user-owned content. Promotion is atomic,
and any failure removes staging without changing the prior managed version.

Scripts are preserved as inert bytes. Import, validation, listing, inspection,
and deployment never execute them.

### Trust and provenance

Every import starts `untrusted` and `inactive` unless an existing explicit trust
decision matches both source locator and digest. Activation requires an
affirmative trust transition. A changed digest invalidates prior activation.
Revoked skills cannot activate. Inspection and validation remain available for
untrusted content.

### Collision precedence

Name collisions resolve deterministically:

1. project-owned skill;
2. user-owned skill;
3. explicitly imported skill;
4. packaged AIWG-managed skill.

The winner is reported with every shadowed origin. AIWG never overwrites,
updates, or removes a higher-precedence user-owned or project-owned skill.

### Provider results

Every provider deployment returns one status:

- `native`: strict portable content is deployed without semantic change;
- `projected`: a documented, semantics-preserving provider representation is
  used;
- `degraded`: accepted data cannot be represented completely and every loss is
  named in `reasons`;
- `unsupported`: no safe representation exists and no deployment is written.

Silent truncation is prohibited. A `degraded` or `unsupported` result must name
the provider, target path when one exists, source digest, and stable reason.

## Testable invariants

1. Strict projections have only the six standard top-level keys.
2. Standard metadata, Markdown, resources, and exact managed source bytes are
   never derived from the sidecar.
3. Sidecar restoration recovers all recognized AIWG metadata omitted from a
   strict projection.
4. Unknown external fields cannot enter AIWG control policy automatically.
5. Source locator, resolved revision for Git, digest, trust, and activation are
   persisted before activation.
6. Project and user collisions cannot be overwritten by imported or packaged
   content.
7. Import and validation perform no script execution.
8. Provider limitations produce explicit `degraded` or `unsupported` results,
   never silent truncation.

## Upstream update policy

The baseline changes only through a reviewed commit that updates all of:

1. `AGENT_SKILLS_BASELINE` in the typed contract;
2. pinned normative and ambiguity fixtures;
3. the reference-validator comparison fixture where its parser accepts input;
4. this ADR and user documentation;
5. the controlled baseline diff recorded by conformance CI.

Runtime import and validation do not fetch upstream specifications or code.
