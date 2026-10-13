/**
 * Guards the npm-package install-ability defect found in review of #3062:
 * every shipped `tools/**` or `bin/**` `.mjs` file that imports something
 * under `src/` must resolve it through `tools/_resolve-impl.mjs`'s
 * `importImpl` (which falls back to `dist/src/` when installed), not a
 * literal relative path straight into `src/` — the installed package does
 * not ship `src/` at all (see `files` in package.json).
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
 * Relative imports from shipped `tools/**\/*.mjs` files into targets that
 * are not themselves shipped, predating #3062 and unrelated to the
 * bounded sync child-process conversion this issue covers (mostly
 * decision-engine study/heldout scripts under `tools/decision/` and
 * `tools/experiments/` that import `src/decision/**\/*.ts` sources
 * directly via a `tsx` loader registered in the same file, plus a few
 * narrower cross-references). Fixing these is out of #3062's scope; they
 * are listed explicitly so this guard still catches *new* unresolvable
 * imports — including a regression of the #3062 bug it exists to prevent
 * — without failing on debt it was never meant to fix.
 *
 * Each entry is `file -> [resolvedRel, ...]`: the exact unshipped target
 * path(s) that file's relative imports resolve to. Narrowed to the known
 * targets (not just the file) so a *different*, new unresolved import
 * added to one of these files still fails the check.
 */
const KNOWN_PREEXISTING_VIOLATIONS: Record<string, string[]> = {
  'tools/agents/providers/omp.mjs': [
    'src/providers/omp-agent.mjs',
    'src/providers/omp-paths.mjs',
  ],
  'tools/cockpit/qualify-desktop-issuer.mjs': [
    'apps/cockpit/bridge/src/desktop-identity-keycloak.mjs',
    'apps/cockpit/bridge/src/desktop-issuer-transport.mjs',
  ],
  'tools/daemon/index.mjs': [
    'tools/docker/container-manager.mjs',
  ],
  'tools/decision/d17-multifact.mjs': [
    'src/decision/context-live-qualification.ts',
    'src/decision/ensemble-study/calibration.ts',
    'src/decision/ensemble-study/multifact-study.ts',
    'src/decision/ensemble-study/staged.ts',
    'src/decision/heldout/calibration.ts',
    'src/decision/heldout/collector.ts',
    'src/decision/heldout/contract.ts',
    'src/decision/heldout/journal.ts',
  ],
  'tools/decision/d17-score.mjs': [
    'src/decision/context-live-qualification.ts',
    'src/decision/ensemble-study/score.ts',
    'src/decision/heldout/calibration.ts',
    'src/decision/heldout/collector.ts',
    'src/decision/heldout/contract.ts',
    'src/decision/heldout/journal.ts',
    'tools/eval/src/integrity.ts',
  ],
  'tools/decision/d17-study.mjs': [
    'src/decision/context-live-qualification.ts',
    'src/decision/ensemble-study/calibration.ts',
    'src/decision/ensemble-study/corpus.ts',
    'src/decision/ensemble-study/score.ts',
    'src/decision/ensemble-study/staged.ts',
    'src/decision/heldout/calibration.ts',
    'src/decision/heldout/contract.ts',
    'src/decision/heldout/journal.ts',
  ],
  'tools/decision/d29-study.mjs': [
    'src/decision/context-live-qualification.ts',
    'src/decision/heldout/journal.ts',
  ],
  'tools/decision/heldout-study.mjs': [
    'src/decision/context-live-qualification.ts',
    'src/decision/heldout/calibration.ts',
    'src/decision/heldout/collector.ts',
    'src/decision/heldout/contract.ts',
    'src/decision/heldout/journal.ts',
  ],
  'tools/decision/studies/d29-calibration.mjs': [
    'src/decision/calibration/registry.ts',
    'src/decision/heldout/calibration.ts',
    'src/decision/heldout/contract.ts',
    'src/decision/qualification/quality.ts',
  ],
  'tools/decision/studies/d29-shortcuts-v7.mjs': [
    'src/decision/heldout/d29-pools.js',
  ],
  'tools/decision/studies/d29-shortcuts-v8.mjs': [
    'src/decision/heldout/d29-pools-v8.js',
  ],
  'tools/decision/studies/d29-shortcuts.mjs': [
    'src/decision/heldout/generators.js',
  ],
  'tools/decision/studies/d29.mjs': [
    'src/config/project-artifacts-runtime.mjs',
    'src/decision/calibration/registry.ts',
    'src/decision/heldout/contract.ts',
    'src/decision/heldout/d29-passage-baseline-v2.ts',
    'src/decision/heldout/d29-passage-baseline-v3.ts',
    'src/decision/heldout/d29-passage-baseline.ts',
    'src/decision/heldout/d29-v6.ts',
    'src/decision/heldout/d29-v7.ts',
    'src/decision/heldout/d29-v8.ts',
    'src/decision/heldout/generator-registry.ts',
    'src/decision/heldout/generators.ts',
    'src/decision/qualification/quality.ts',
    'src/decision/qualification/release.ts',
    'src/decision/sdlc-screening.ts',
    'src/decision/validate.ts',
    'src/gates/discovery.ts',
    'src/gates/evaluate.ts',
    'src/gates/floors.ts',
    'src/gates/providers/index.ts',
    'src/gates/registry.ts',
  ],
  'tools/experiments/conformal/collect-jev.v2.mjs': [
    'src/decision/index.ts',
  ],
  'tools/experiments/conformal/run.mjs': [
    'src/decision/acceptance.ts',
    'src/decision/qualification/quality.ts',
    'tools/eval/src/integrity.ts',
  ],
  'tools/experiments/conformal/run.v2.mjs': [
    'src/decision/acceptance.ts',
    'tools/eval/src/integrity.ts',
  ],
  'tools/mission-protocol/migrate.mjs': [
    'src/mission-protocol/index.ts',
  ],
  'tools/providers/omp-conformance.mjs': [
    'src/providers/omp-agent.mjs',
  ],
  'tools/providers/omp-mcp-conformance.mjs': [
    'src/mcp/omp-config.mjs',
  ],
  'tools/testing/audit-conformance-inventory.mjs': [
    'src/config/project-artifacts-runtime.mjs',
  ],
  'tools/testing/run-conformance-example.mjs': [
    'src/config/project-artifacts-runtime.mjs',
  ],
  'tools/testing/verify-coverage-enforcement.mjs': [
    'config/vitest.testing-quality-coverage.config.js',
  ],
};

function isKnownPreexisting(violation: { file: string; resolvedRel: string }): boolean {
  return (KNOWN_PREEXISTING_VIOLATIONS[violation.file] ?? []).includes(violation.resolvedRel);
}

describe('shipped tools/**/*.mjs and bin/** relative imports resolve (#3062 finding 1)', () => {
  it('every relative import not already known-pre-existing resolves to a packed file', () => {
    const packed = inject('basePackageManifest');
    const packedFiles = packed.files.map((file) => file.path);

    const violations = checkPackedRelativeImports({ root: ROOT, packedFiles });
    const unexpected = violations.filter((violation) => !isKnownPreexisting(violation));

    expect(
      unexpected,
      `New unresolvable relative import(s) in shipped tools/**/*.mjs or bin/** — these will throw ` +
        `ERR_MODULE_NOT_FOUND once installed from npm (src/ is not shipped; use ` +
        `importImpl(import.meta.url, '<path>') from tools/_resolve-impl.mjs instead of a literal ` +
        `relative path into src/):\n${JSON.stringify(unexpected, null, 2)}`,
    ).toEqual([]);
  });

  it('no shipped tools/**/*.mjs file has an unresolved import into src/process/bounded-child-process.mjs (#3062)', () => {
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

  it('flags an unresolved dynamic import() the same way as a static import', () => {
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
      },
    ]);
  });
});
