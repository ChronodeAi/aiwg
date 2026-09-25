# Film Production

A provider-neutral AIWG framework for reference-driven films, animated shorts and episodic content: **develop → design → previs → generate → finish → deliver**. It turns story intent, immutable references and physical shot states into reviewable media and verified delivery. It does not generate media by itself.

Start with [film-production-quickref](skills/film-production-quickref/SKILL.md). It routes to 12 operational skills, seven rules, six specialists, eight lifecycle/revision flows and eight templates. Read only the needed capability. Counts are a catalog, not a requirement to invoke every component.

## Use

```sh
aiwg use film-production --provider codex
aiwg discover "film production workflow" --limit 3
aiwg show skill film-production-quickref
aiwg show skill film-intake
aiwg show template film-shot-record
```

Reload the provider session after deployment for new kernel/agent listings. Standard skills are retrieved through discovery; absence from the flat provider list is expected. Commands are generated from skills, not separately authored source duplicates. This framework does not alter the user's model selection or install media services.

## The production contract

- One current state, exact input versions and dimension-specific approvals; historical decisions do not compete with current state.
- Preserve sharp aesthetic masters, character/hand references and real artwork/screens; blocking drafts never silently become final imagery.
- Explicit prop counts, hand occupancy, contacts, reach, attachments, camera limits and causal action coverage.
- Contextual voice/music/foley review; distinguish internal thought from audible dialogue and generated duration from edit duration.
- Inspect the requested fix and scene invariants, then actual motion/audio before accepting temporal results.
- Reconcile uncertain provider tasks, record costs, honor existing authority; pause and publication are separate states.

## Catalog

[Taxonomy](docs/taxonomy.md) · [Primary sources](docs/sources.md) · [Existing framework interfaces](docs/interfaces.md) · [Lifecycle](plan-act-film-production.md) · [Roles](actors-and-templates.md) · [Metrics](metrics/tracking-catalog.md)

Rules are agent procedures. The [state checker](scripts/validate-film-state.mjs) checks recorded promotion constraints; it cannot inspect images, authenticate a reviewer or prove creative quality. Run `node scripts/validate-film-state.mjs <state.json>` from this framework directory. The [synthetic example](examples/production-state.example.json) demonstrates format, not a live approval.

## Integration and scope

This is a new domain package in the AIWG source checkout. The modern portable manifest, kernel metadata and ordinary directory layout follow current docs/customization; legacy scaffold fields were replaced. See [integration notes](docs/integration.md) for checks and limitations. The [quickref's editor routing](skills/film-production-quickref/SKILL.md#editor-and-motion-graphics-routing) distinguishes DaVinci Resolve MCP/scripting adapters from Mirage Tesseract's `tesseract-video` / `tesseract-motion` skills and local `tsrct` CLI. Verify discovery, permissions and a real render in each provider; no official Tesseract MCP or editable cross-editor round-trip is assumed. Source adapters may also use existing image/video/TTS skills when present; capability and price must be verified at run time. OpenUSD, OTIO, ACES and C2PA are optional integrations with separate conformance requirements.

The initial regression scenarios came from a private production audit; project-specific characters, voices, secrets, media and approvals remain in that project. No existing movie approval is created or changed by installing this framework. No public post or paid generation is part of framework setup.
