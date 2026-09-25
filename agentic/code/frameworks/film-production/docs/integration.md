# AIWG integration and verification

This framework follows the current customization lifecycle and portable manifest
schema rather than copying the legacy scaffold manifest verbatim.

## Source integration

- Conventional source root: `agentic/code/frameworks/film-production/`.
- Modern manifest: `manifestVersion: "1"`, `frameworkConfig`, platforms,
  keywords and deployment metadata. Version follows repository CalVer.
- Public CLI registration: the existing `VALID_FRAMEWORKS`, `MODE_MAP` and
  `FRAMEWORK_DIR_MAP` entries in `src/cli/handlers/use.ts` include film-production.
- Provider framework inventory and kernel discovery are dynamic. The quickref
  carries `kernel: true`; standard skills stay source-indexed by default.
- Agents pin `model: sonnet` with `model-role: reasoning` and `model-tier: standard`,
  matching other frameworks' standard-tier agents, so subagents do not inherit a
  large-context parent model. Skills carry commandHint.modelRole/modelTier. These
  are agent routing settings, not media model IDs or a change to the user's
  session model.

The framework creation guide and scaffold command currently emit legacy manifest
fields. The new framework replaces those with the strict schema accepted by the
runtime. This is a recorded integration discrepancy; the global scaffolder was
not changed as part of film authoring.

## Verification commands

Use the installation's approved Node runtime. From the AIWG source root:

```sh
npm run build:cli
node tools/cli/validate-metadata.mjs --recursive --ci --profile compatible --format json agentic/code/frameworks/film-production
node --test agentic/code/frameworks/film-production/scripts/validate-film-state.test.mjs
node agentic/code/frameworks/film-production/scripts/validate-film-state.mjs agentic/code/frameworks/film-production/examples/production-state.example.json
npm run schema:catalog -- --check
```

The state checker validates shape with the JSON schema (Ajv, a runtime dependency)
and then applies gate rules. `fixtures/valid/` and `fixtures/invalid/` hold the
reference states; each invalid fixture has a documented expected failure in the test.

The public CLI was dry-run then deployed into an isolated test project using
`aiwg use film-production --provider codex`. Its readiness check completed;
quickref, six film agents and seven rules were read back. This includes normal
AIWG utility deployment; it does not imply every provider has been tested.
Codex integration tests also check dynamic discovery, public handler routing,
portable manifest validity and the full kernel listing budget.

After source additions, rebuild the framework index when discovery is stale:
`aiwg index build --graph framework --force`. Use discover/show to verify actual
retrieval, not just file existence. Reload a deployed provider session to expose
new kernel skills and agents. Building/indexing source alone does not install the
framework into every existing project.

## Limits

Rules are procedures. The optional state checker validates recorded structure,
input-hash references, current review evidence, explicit user-review dimensions,
defect dispositions and promotion/spend conditions. It does not inspect media,
authenticate approvals, verify local file hashes or submit/stop provider jobs.
Its current executable contract covers image-to-video shot promotion; the wider
taxonomy includes other production methods handled through skills and review.

No live model generation, NLE editing, external media upload, or public posting
is performed by installation. A future bounded production pilot must measure
actual quality, speed and cost gains. Optional format adapters and provider
capabilities require their own verification.

Source references: `docs/customization/project-local-quickstart.md`,
`project-local-lifecycle.md`, `extensions-vs-addons-vs-frameworks-vs-plugins.md`,
`docs/cli/capability-routing.md`, and `src/extensions/manifest.ts` in AIWG.
