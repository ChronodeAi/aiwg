# Framework relationship tables

`buildIndex(cwd, { graph: 'framework' })` writes `relations.json` beside
`metadata.json` beneath the root-keyed framework directory from
`framework-index-paths.ts`: `<xdg>/aiwg/index/roots/<sha256(root)>/framework/`.
The v1 schema is `schemas/artifacts/relations.v1.schema.json` and is shipped in
the package. Missing or changed sidecars invalidate the existing reconciliation
receipt and are repaired under its directory lock, including incremental builds.

The sidecar contains:

- `rules[id]`: source path, rule/behavior type, activation, enforcement, authored
  summary, owning capability, path globs, original binding patterns and resolved targets.
- `targets["type:id"]`: ordered governing rule IDs and precomputed `rule_stats`
  by enforcement and activation. `required_checks` counts critical/high contracts;
  it does not claim mechanical enforcement.
- `capabilities["kind:bundle"]`: framework/addon/extension rule IDs by tier.
  Nested extensions retain their outer source owner; top-level behaviors are unowned.
- `aliases`: canonical names and layout slugs, with ambiguity retained explicitly.
- `artifacts`: compact identity/title/kernel/script metadata for show matching.
- `fingerprint`: sorted rule/action source paths and checksums, plus extractor
  revision. Incremental builds retain unchanged table bytes and mtimes.

Forward edges use deploy's strict `resolveRuleBindingTarget` precedence. Reverse
edges retain show's alias/glob semantics and ordering, including behavior
contracts. These contracts intentionally differ: a legacy show glob is not a
canonical deploy target. Missing or ambiguous forward bindings fail the build.
A bound flow also gets `skill:projected:<flow-discover-id>` with `projected_from`.
Its rules and stats match the flow; authored skills keep their existing output.

## Build and package

`npm run release:fortemi-index` (also the existing `prepack` hook) emits:

```
prebuilt/framework-relations/
  relations.json
  bindings.json
  manifest.json
prebuilt/fortemi-core/framework/
  aiwg-fortemi-index-v2.json
  manifest.json
```

`bindings.json` has schema version `aiwg.bindings.resolved.v1`: concrete target
IDs by type for each rule, reverse target rules/stats including flow projections,
and provider rule sets (kernel, summary, native/discoverable paths, bound,
on-demand). These are corpus sets before mode/tier selection or operator pins.
Legacy activation inference and Hermes's critical-only tagged kernel policy are
resolved at build time. Provider delivery itself is unchanged in round 1.

The relationship manifest records `aiwg.relationships.prebuilt.v1`, package
version, a portable SHA-256 source digest and checksums for both tables. Tables
use a fixed epoch for reproducibility; mtimes and absolute roots never enter
published bytes. Generated `prebuilt/` files follow the existing ignored-build
output convention. The manifest is published last under the Fortemi build lock.

`npm run lint:relations-prebuilt-package` checks staleness without running
prepack or repairing tables. It is included in `ci:fortemi-index`; the tarball
audit requires all three files. The corpus test lane generates tables once,
then compares them byte for byte with an independently isolated fresh build.

## Runtime selection

`selectPrebuiltRelations(cwd)` checks the running corpus root's package version,
source digest and table checksum. The portable digest includes corpus sources,
provider schemas and projection scripts; development-only corpus package/lock/
tsconfig files excluded from the tarball do not enter it. A stat/checksum receipt
under the root-keyed index caches content hashes. Warm checks enumerate/stat
sources without rereading their contents, detecting additions, deletions and
same-size edits even when mtime is restored (ctime participates in the receipt).

`loadRelations` synchronously selects prebuilt, then the built sidecar.
`ensureRelations` also reconciles a stale/missing built sidecar via the existing
fingerprint/lock workflow and reports why an existing prebuilt stamp was rejected.
Neither reader loads `metadata.json`. `show` uses the compact catalog and reader,
merging project/user bindings and reading requested rule bodies concurrently.
Project overrides with distinct IDs retain the old alias/glob matching through
the small original-pattern records.
MCP show uses the same CLI path. Discover attaches rule summaries and stats using
the reader and uses the compact Fortemi export when its shipped digest matches;
full indexes remain available for text search and other artifact types.

Cold builds and stale-index tests use isolated roots/HOMEs. Run
`tools/benchmarks/relations.mjs build|read` after `npm run build:cli` for timings,
bytes and lookup RSS, with isolated HOME/XDG/TMPDIR settings.
