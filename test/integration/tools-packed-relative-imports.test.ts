/**
 * Guards the npm-package install-ability defect found in review of #3062:
 * every shipped executable file under `tools/`, `bin/`, or `dist/src/`
 * that imports something outside the packed set must resolve it through
 * `tools/_resolve-impl.mjs`'s `importImpl` (which falls back to
 * `dist/src/` when installed), not a literal relative path into `src/` —
 * the installed package does not ship `src/` at all (see `files` in
 * package.json).
 *
 * Uses the real `npm pack --dry-run --json` manifest (shared, cached once
 * per run via the `basePackageManifest` global-setup fixture — see
 * test/helpers/base-package-setup.mjs) so this checks the actual packed
 * file list, not an assumption about what `files` includes.
 *
 * @integration
 * @implements #3062 finding 1
 */
import path from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import { checkPackedRelativeImports } from '../helpers/packed-relative-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * Relative imports from shipped executable files into targets that are
 * not themselves shipped, predating #3062 and unrelated to the bounded
 * sync child-process conversion this issue covers (mostly decision-engine
 * study/replay/heldout scripts under `tools/decision/` and
 * `tools/experiments/` that import `src/decision/**\/*.ts` sources
 * directly — some via a `tsx` loader registered in the same file, some
 * compiled sibling `.js` references — plus a few narrower
 * cross-references). Fixing these is out of #3062's scope; they are
 * listed explicitly so this guard still catches *new* unresolvable
 * imports — including a regression of the #3062 bug it exists to prevent
 * — without failing on debt it was never meant to fix.
 *
 * Keyed by `(importing file, resolved target, lazy-or-eager)`, not just
 * target (#3062 B/C finding 2): keying by target alone would let a *new*
 * import added to an already-exempted file hide inside the exemption, and
 * `lazy` is part of the key because changing a lazy (deferred, inside a
 * function) import to eager (resolved unconditionally at module load) is
 * itself a behavior change this guard should not silently wave through.
 */
const KNOWN_PREEXISTING_VIOLATIONS: Record<string, { resolvedRel: string; lazy: boolean }[]> = {
  'tools/cockpit/qualify-desktop-issuer.mjs': [
    { resolvedRel: 'apps/cockpit/bridge/src/desktop-identity-keycloak.mjs', lazy: false },
    { resolvedRel: 'apps/cockpit/bridge/src/desktop-issuer-transport.mjs', lazy: false },
  ],
  'tools/daemon/index.mjs': [
    { resolvedRel: 'tools/docker/container-manager.mjs', lazy: true },
  ],
  'tools/decision/comparative-replay-assets.ts': [
    { resolvedRel: 'src/decision/entry.js', lazy: false },
    { resolvedRel: 'src/decision/compile-cache/identity.js', lazy: false },
    { resolvedRel: 'tools/decision/comparative-replay-corpus.js', lazy: false },
  ],
  'tools/decision/comparative-replay-corpus.ts': [
    { resolvedRel: 'src/decision/compile-cache/identity.js', lazy: false },
    { resolvedRel: 'src/decision/validate.js', lazy: false },
    { resolvedRel: 'src/decision/types.js', lazy: false },
    { resolvedRel: 'src/decision/sensitivity/types.js', lazy: false },
  ],
  'tools/decision/comparative-replay.ts': [
    { resolvedRel: 'src/security/artifact-trust.js', lazy: false },
    { resolvedRel: 'src/decision/validate.js', lazy: false },
    { resolvedRel: 'src/decision/sensitivity/runtime.js', lazy: false },
    { resolvedRel: 'src/decision/sensitivity/contract.js', lazy: false },
    { resolvedRel: 'src/decision/sensitivity/comparative.js', lazy: false },
    { resolvedRel: 'src/decision/qualification/release.js', lazy: false },
    { resolvedRel: 'src/decision/sensitivity/types.js', lazy: false },
    { resolvedRel: 'tools/decision/comparative-replay-assets.js', lazy: false },
    { resolvedRel: 'tools/decision/comparative-replay-corpus.js', lazy: false },
  ],
  'tools/decision/d17-multifact.mjs': [
    { resolvedRel: 'src/decision/ensemble-study/multifact-study.ts', lazy: true },
    { resolvedRel: 'src/decision/context-live-qualification.ts', lazy: true },
    { resolvedRel: 'src/decision/heldout/journal.ts', lazy: true },
    { resolvedRel: 'src/decision/heldout/contract.ts', lazy: true },
    { resolvedRel: 'src/decision/heldout/calibration.ts', lazy: true },
    { resolvedRel: 'src/decision/ensemble-study/calibration.ts', lazy: true },
    { resolvedRel: 'src/decision/ensemble-study/staged.ts', lazy: true },
    { resolvedRel: 'src/decision/heldout/collector.ts', lazy: true },
  ],
  'tools/decision/d17-score.mjs': [
    { resolvedRel: 'src/decision/heldout/calibration.ts', lazy: true },
    { resolvedRel: 'src/decision/heldout/collector.ts', lazy: true },
    { resolvedRel: 'src/decision/heldout/journal.ts', lazy: true },
    { resolvedRel: 'tools/eval/src/integrity.ts', lazy: true },
    { resolvedRel: 'src/decision/heldout/contract.ts', lazy: true },
    { resolvedRel: 'src/decision/ensemble-study/score.ts', lazy: true },
    { resolvedRel: 'src/decision/context-live-qualification.ts', lazy: false },
    { resolvedRel: 'src/decision/heldout/journal.ts', lazy: false },
    { resolvedRel: 'src/decision/heldout/collector.ts', lazy: false },
    { resolvedRel: 'src/decision/heldout/contract.ts', lazy: false },
  ],
  'tools/decision/d17-study.mjs': [
    { resolvedRel: 'src/decision/ensemble-study/staged.ts', lazy: true },
    { resolvedRel: 'src/decision/ensemble-study/corpus.ts', lazy: true },
    { resolvedRel: 'src/decision/ensemble-study/score.ts', lazy: true },
    { resolvedRel: 'src/decision/context-live-qualification.ts', lazy: true },
    { resolvedRel: 'src/decision/heldout/journal.ts', lazy: true },
    { resolvedRel: 'src/decision/heldout/contract.ts', lazy: true },
    { resolvedRel: 'src/decision/heldout/calibration.ts', lazy: true },
    { resolvedRel: 'src/decision/ensemble-study/calibration.ts', lazy: true },
  ],
  'tools/decision/d29-study.mjs': [
    { resolvedRel: 'src/decision/context-live-qualification.ts', lazy: true },
    { resolvedRel: 'src/decision/heldout/journal.ts', lazy: true },
  ],
  'tools/decision/heldout-study.mjs': [
    { resolvedRel: 'src/decision/heldout/contract.ts', lazy: false },
    { resolvedRel: 'src/decision/heldout/journal.ts', lazy: false },
    { resolvedRel: 'src/decision/context-live-qualification.ts', lazy: false },
    { resolvedRel: 'src/decision/heldout/calibration.ts', lazy: false },
    { resolvedRel: 'src/decision/heldout/collector.ts', lazy: false },
  ],
  'tools/decision/studies/d29-calibration.mjs': [
    { resolvedRel: 'src/decision/heldout/contract.ts', lazy: false },
    { resolvedRel: 'src/decision/heldout/calibration.ts', lazy: false },
    { resolvedRel: 'src/decision/calibration/registry.ts', lazy: false },
    { resolvedRel: 'src/decision/qualification/quality.ts', lazy: false },
  ],
  'tools/decision/studies/d29-shortcuts-v7.mjs': [
    { resolvedRel: 'src/decision/heldout/d29-pools.js', lazy: false },
  ],
  'tools/decision/studies/d29-shortcuts-v8.mjs': [
    { resolvedRel: 'src/decision/heldout/d29-pools-v8.js', lazy: false },
  ],
  'tools/decision/studies/d29-shortcuts.mjs': [
    { resolvedRel: 'src/decision/heldout/generators.js', lazy: false },
  ],
  'tools/decision/studies/d29.mjs': [
    { resolvedRel: 'src/decision/heldout/contract.ts', lazy: false },
    { resolvedRel: 'src/decision/heldout/generators.ts', lazy: false },
    { resolvedRel: 'src/decision/qualification/quality.ts', lazy: false },
    { resolvedRel: 'src/decision/qualification/release.ts', lazy: false },
    { resolvedRel: 'src/decision/calibration/registry.ts', lazy: false },
    { resolvedRel: 'src/decision/validate.ts', lazy: false },
    { resolvedRel: 'src/decision/sdlc-screening.ts', lazy: false },
    { resolvedRel: 'src/gates/evaluate.ts', lazy: false },
    { resolvedRel: 'src/gates/floors.ts', lazy: false },
    { resolvedRel: 'src/config/project-artifacts-runtime.mjs', lazy: false },
    { resolvedRel: 'src/gates/discovery.ts', lazy: false },
    { resolvedRel: 'src/gates/registry.ts', lazy: false },
    { resolvedRel: 'src/gates/providers/index.ts', lazy: false },
    { resolvedRel: 'src/decision/heldout/d29-v6.ts', lazy: false },
    { resolvedRel: 'src/decision/heldout/d29-v7.ts', lazy: false },
    { resolvedRel: 'src/decision/heldout/d29-v8.ts', lazy: false },
    { resolvedRel: 'src/decision/heldout/generator-registry.ts', lazy: false },
    { resolvedRel: 'src/decision/heldout/d29-passage-baseline-v2.ts', lazy: false },
    { resolvedRel: 'src/decision/heldout/d29-passage-baseline-v3.ts', lazy: false },
    { resolvedRel: 'src/decision/heldout/d29-passage-baseline.ts', lazy: false },
  ],
  'tools/experiments/conformal/collect-jev.v2.mjs': [
    { resolvedRel: 'src/decision/index.ts', lazy: false },
  ],
  'tools/experiments/conformal/run.mjs': [
    { resolvedRel: 'src/decision/acceptance.ts', lazy: false },
    { resolvedRel: 'tools/eval/src/integrity.ts', lazy: false },
    { resolvedRel: 'src/decision/qualification/quality.ts', lazy: false },
  ],
  'tools/experiments/conformal/run.v2.mjs': [
    { resolvedRel: 'src/decision/acceptance.ts', lazy: false },
    { resolvedRel: 'tools/eval/src/integrity.ts', lazy: false },
  ],
  'tools/mission-protocol/migrate.mjs': [
    { resolvedRel: 'src/mission-protocol/index.ts', lazy: true },
  ],
  'tools/providers/omp-conformance.mjs': [
    { resolvedRel: 'src/providers/omp-agent.mjs', lazy: false },
  ],
  'tools/providers/omp-mcp-conformance.mjs': [
    { resolvedRel: 'src/mcp/omp-config.mjs', lazy: false },
  ],
  'tools/testing/audit-conformance-inventory.mjs': [
    { resolvedRel: 'src/config/project-artifacts-runtime.mjs', lazy: false },
  ],
  'tools/testing/run-conformance-example.mjs': [
    { resolvedRel: 'src/config/project-artifacts-runtime.mjs', lazy: false },
  ],
  'tools/testing/verify-coverage-enforcement.mjs': [
    { resolvedRel: 'config/vitest.testing-quality-coverage.config.js', lazy: false },
  ],
};

function isKnownPreexisting(violation: { file: string; resolvedRel: string; lazy: boolean }): boolean {
  return (KNOWN_PREEXISTING_VIOLATIONS[violation.file] ?? []).some(
    (entry) => entry.resolvedRel === violation.resolvedRel && entry.lazy === violation.lazy,
  );
}

describe('shipped tools/**, bin/**, and dist/src/** relative imports resolve (#3062 finding 1)', () => {
  it('every relative import not already known-pre-existing resolves to a packed file', () => {
    const packed = inject('basePackageManifest');
    const packedFiles = packed.files.map((file) => file.path);

    const violations = checkPackedRelativeImports({ root: ROOT, packedFiles });
    const unexpected = violations.filter((violation) => !isKnownPreexisting(violation));

    expect(
      unexpected,
      `New unresolvable relative import(s) in a shipped tools/**, bin/**, or dist/src/** file — these ` +
        `will throw ERR_MODULE_NOT_FOUND once installed from npm (src/ is not shipped; use ` +
        `importImpl(import.meta.url, '<path>') from tools/_resolve-impl.mjs instead of a literal ` +
        `relative path into src/). This also fails on a known-pre-existing edge that changed from ` +
        `lazy to eager (or vice versa) — update KNOWN_PREEXISTING_VIOLATIONS deliberately if that was ` +
        `intended:\n${JSON.stringify(unexpected, null, 2)}`,
    ).toEqual([]);
  });

  it('no shipped file has an unresolved import into src/process/bounded-child-process.mjs (#3062)', () => {
    const packed = inject('basePackageManifest');
    const packedFiles = packed.files.map((file) => file.path);

    const violations = checkPackedRelativeImports({ root: ROOT, packedFiles });
    const boundedProcessViolations = violations.filter(
      (violation) => violation.resolvedRel === 'src/process/bounded-child-process.mjs',
    );

    expect(boundedProcessViolations).toEqual([]);
  });
});

describe('checkPackedRelativeImports — proves the guard actually catches a violation', () => {
  it('flags a shipped tools/**/*.mjs file with a literal relative import into an unshipped src/ path', () => {
    const packedFiles = ['tools/example/broken.mjs'];
    const violations = checkPackedRelativeImports({
      root: ROOT,
      packedFiles,
      readFile: () => "import { boundedExecSync } from '../../src/process/bounded-child-process.mjs';\nboundedExecSync('x', 'quick');\n",
    });

    expect(violations).toEqual([
      {
        file: 'tools/example/broken.mjs',
        spec: '../../src/process/bounded-child-process.mjs',
        resolvedRel: 'src/process/bounded-child-process.mjs',
        lazy: false,
      },
    ]);
  });

  it('does not flag a bare (non-relative) module specifier', () => {
    const packedFiles = ['tools/example/ok.mjs'];
    const violations = checkPackedRelativeImports({
      root: ROOT,
      packedFiles,
      readFile: () => "import fs from 'node:fs';\nimport chalk from 'chalk';\n",
    });

    expect(violations).toEqual([]);
  });

  it('does not flag a relative import that does resolve within the packed set', () => {
    const packedFiles = ['tools/example/ok.mjs', 'tools/_resolve-impl.mjs'];
    const violations = checkPackedRelativeImports({
      root: ROOT,
      packedFiles,
      readFile: (absolutePath: string) =>
        absolutePath.endsWith('tools/example/ok.mjs')
          ? "import { importImpl } from '../_resolve-impl.mjs';\nimportImpl;\n"
          : "export function importImpl() {}\n",
    });

    expect(violations).toEqual([]);
  });

  it('flags an unresolved top-level (eager) dynamic import() the same way as a static import', () => {
    const packedFiles = ['tools/example/broken-dynamic.mjs'];
    const violations = checkPackedRelativeImports({
      root: ROOT,
      packedFiles,
      readFile: () => "const { boundedExecSync } = await import('../../src/process/bounded-child-process.mjs');\nboundedExecSync('x', 'quick');\n",
    });

    expect(violations).toEqual([
      {
        file: 'tools/example/broken-dynamic.mjs',
        spec: '../../src/process/bounded-child-process.mjs',
        resolvedRel: 'src/process/bounded-child-process.mjs',
        lazy: false,
      },
    ]);
  });

  it('flags an unresolved import() nested in a function as lazy, distinct from the same import at top level', () => {
    const packedFiles = ['tools/example/broken-lazy.mjs'];
    const violations = checkPackedRelativeImports({
      root: ROOT,
      packedFiles,
      readFile: () => [
        'export async function getHelper() {',
        "  const { boundedExecSync } = await import('../../src/process/bounded-child-process.mjs');",
        '  return boundedExecSync;',
        '}',
      ].join('\n'),
    });

    expect(violations).toEqual([
      {
        file: 'tools/example/broken-lazy.mjs',
        spec: '../../src/process/bounded-child-process.mjs',
        resolvedRel: 'src/process/bounded-child-process.mjs',
        lazy: true,
      },
    ]);
  });

  it('flags an unresolved import in a shipped .ts tool file, not just .mjs (#3062 B/C finding 2)', () => {
    const packedFiles = ['tools/example/broken.ts'];
    const violations = checkPackedRelativeImports({
      root: ROOT,
      packedFiles,
      readFile: () => "import { boundedExecSync } from '../../src/process/bounded-child-process.mjs';\nboundedExecSync('x', 'quick');\n",
    });

    expect(violations).toEqual([
      {
        file: 'tools/example/broken.ts',
        spec: '../../src/process/bounded-child-process.mjs',
        resolvedRel: 'src/process/bounded-child-process.mjs',
        lazy: false,
      },
    ]);
  });

  it('does not flag an unexecutable .d.ts declaration file', () => {
    const packedFiles = ['tools/example/types.d.ts'];
    const violations = checkPackedRelativeImports({
      root: ROOT,
      packedFiles,
      readFile: () => "import type { Thing } from '../../src/process/not-shipped.js';\n",
    });

    expect(violations).toEqual([]);
  });

  it('flags an unresolved import in a built dist/src/**/*.js file (#3062 B/C finding 2)', () => {
    const packedFiles = ['dist/src/cli/handlers/example.js'];
    const violations = checkPackedRelativeImports({
      root: ROOT,
      packedFiles,
      readFile: () => "import { thing } from '../../../../tools/not-shipped.mjs';\nthing();\n",
    });

    expect(violations).toEqual([
      {
        file: 'dist/src/cli/handlers/example.js',
        spec: '../../../../tools/not-shipped.mjs',
        resolvedRel: 'tools/not-shipped.mjs',
        lazy: false,
      },
    ]);
  });
});
