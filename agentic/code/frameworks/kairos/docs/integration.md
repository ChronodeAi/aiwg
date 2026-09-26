# AIWG integration and verification

## Source integration

- Source root: `agentic/code/frameworks/kairos/`, discovered dynamically by the deployer (`tools/agents/providers/base.mjs` `discoverFrameworks`).
- Portable manifest: `manifestVersion: "1"`, `frameworkConfig`, platforms, keywords, deployment and `memory.creates`. The strict bundle schema (`src/extensions/manifest.ts`) has no field for phases, gates or component lists, so phases and gates live in this README and the flows, the workspace is declared through `memory.creates` (created by `aiwg use kairos`), and the skill catalog, including `kairos-conformance-probe`, is `skills/manifest.json` (`type: skills-catalog`, the convention `sdlc-complete` and `media-marketing-kit` use).
- CLI registration: `VALID_FRAMEWORKS`, `MODE_MAP` and `FRAMEWORK_DIR_MAP` in `src/cli/handlers/use.ts`; help text in `src/cli/handlers/help.ts` and `bin/aiwg.mjs`; `tools/cli/wizard.mjs`.
- Kernel: `kairos-quickref` carries `kernel: true`; the canonical inventory is 29 kernel skills with 12 quickrefs. Standard skills stay source-indexed.
- Agents pin `model: sonnet` with `model-role`/`model-tier`; skills carry `commandHint`. These route subagents; they do not change the user's session model.
- Schemas carry `$schema`, `$id` and `title` and are registered in `schemas/catalog/domains/repository-json-schemas.json` (regenerate with `node tools/scripts/build-schema-catalog.mjs` after `git add`). `conformance-claim.schema.json` belongs to the conformance probe suite.

The legacy `aiwg scaffold-framework` command emits fields the strict manifest schema rejects, and it writes to `$AIWG_ROOT` rather than the current checkout, so this framework was authored by hand to the `film-production` layout.

## Verification commands

From the AIWG source root, with the approved Node runtime:

```sh
npm run build:cli
node --test agentic/code/frameworks/kairos/scripts/kairos-scripts.test.mjs
node agentic/code/frameworks/kairos/scripts/kairos-records.mjs validate agentic/code/frameworks/kairos/examples/{review-packet,finding,connection-record,edge-proposal}.example.json
node agentic/code/frameworks/kairos/scripts/kairos-gates.mjs agentic/code/frameworks/kairos/examples/evidence-bundle.example.json
node tools/cli/validate-metadata.mjs --recursive --ci --profile compatible --format json agentic/code/frameworks/kairos
npm run lint:schemas && npm run schema:catalog:check
npm run lint:discovery-coverage && npm run lint:rule-triggers
env -u AIWG_ROOT npx vitest run --config config/vitest.config.js test/unit/cli/handlers/use-kairos.test.ts test/integration/kernel-deployment-conformance.test.ts
```

`computeAllKernelNames` prefers an ambient `AIWG_ROOT`, so run the kernel tests without one (or pointing at this checkout).

To check discovery without touching the shared index or another checkout, isolate the user config and XDG directories and point `AIWG_ROOT` at this checkout:

```sh
export AIWG_CONFIG=/tmp/kairos-verify/config XDG_DATA_HOME=/tmp/kairos-verify/data XDG_CACHE_HOME=/tmp/kairos-verify/cache AIWG_ROOT="$PWD"
node bin/aiwg.mjs index build --graph framework --force
node bin/aiwg.mjs discover "kairos conformance" --limit 5
node bin/aiwg.mjs discover "kairos review packet" --limit 5
```

Without `AIWG_CONFIG`, a developer machine in dev mode routes `bin/aiwg.mjs` to the configured edge checkout, not this one.

## Limits

Rules are procedures. The scripts check recorded structure, hashes, fingerprints, gate arithmetic and credential patterns; they cannot see the node, prove a command ran, or authenticate a reviewer. `kairos-connect.mjs` is the only script that sends requests, and only to the declared node's public health, readiness, meta, MCP and `auth/me` routes.
