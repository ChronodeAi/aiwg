import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectPackRegistry, qualificationErrors, registryPath, requiredPacks } from '../../../tools/testing/check-orchestration-packs.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const checker = pathToFileURL(path.join(root, 'tools/testing/check-orchestration-packs.mjs')).href;
const registry = () => JSON.parse(readFileSync(path.join(root, registryPath), 'utf8'));
const roots: string[] = [];
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('S0 T-OG registry wiring gate (partial coverage is not release acceptance)', () => {
  it('maps all sixteen requested packs to an issue/slice and existing tests', () => {
    const report = inspectPackRegistry(registry(), root);
    expect(Object.keys(report.packs)).toEqual(requiredPacks);
    expect(report.errors).toEqual([]);
    expect(report.result).toBe('wiring-valid');
    expect(report.releaseQualification).toBe('unqualified');
    expect(Object.values(report.packs).some((pack: any) => pack.status === 'implemented')).toBe(false);
    // T-OG-04/05 carry Tier 0 fixture coverage (#2954); T-OG-06 still has no
    // managed-runtime files, so the file-less rejection cases below use it.
    expect(report.packs['T-OG-04'].status).toBe('partial');
    expect(report.packs['T-OG-04'].testFiles.length).toBeGreaterThan(0);
    expect(report.packs['T-OG-05'].status).toBe('partial');
    expect(report.packs['T-OG-05'].testFiles.length).toBeGreaterThan(0);
    expect(report.packs['T-OG-06'].testFiles).toEqual([]);
  });

  it.each(['partial', 'implemented'])('rejects %s without test files', status => {
    const value = registry();
    value.packs['T-OG-06'].status = status;
    expect(inspectPackRegistry(value, root).errors).toContain(`T-OG-06: ${status} without test files`);
  });

  it('rejects a declared file that has not landed rather than treating it as implemented', () => {
    const value = registry();
    value.packs['T-OG-02'].status = 'implemented';
    value.packs['T-OG-02'].testFiles = ['test/conformance/not-landed.test.ts'];
    expect(inspectPackRegistry(value, root).errors).toContain('T-OG-02: missing or invalid test file test/conformance/not-landed.test.ts');
  });

  it('rejects missing pack, owner, and slice metadata', () => {
    const value = registry();
    delete value.packs['T-OG-03'];
    delete value.packs['T-OG-01'].ownerIssue;
    value.packs['T-OG-01'].slice = 'S6';
    expect(inspectPackRegistry(value, root).errors).toEqual(expect.arrayContaining([
      'T-OG-03: missing pack', 'T-OG-01: owning issue is required', 'T-OG-01: owning slice must be S0–S5',
    ]));
  });

  it.each(['missing', 'unqualified'])('rejects %s qualification reported as a pass', qualification => {
    expect(qualificationErrors([{ id: 'synthetic', qualification, result: 'passed' }]))
      .toEqual(['synthetic: missing qualification cannot be reported as a pass']);
  });

  it('accepts an explicit unqualified result and requires scoped live evidence for a pass', () => {
    expect(qualificationErrors([{ id: 'missing-binary', qualification: 'missing', result: 'blocked' }])).toEqual([]);
    const qualified = { id: 'synthetic-report-validation-only', qualification: 'qualified', result: 'passed', evidence: {
      kind: 'live', version: 'fixture-version', account: 'fixture-account', profile: 'fixture-profile', transport: 'shell', reportRef: 'synthetic-reference',
    } };
    expect(qualificationErrors([qualified])).toEqual([]);
    expect(qualificationErrors([{ ...qualified, evidence: { kind: 'synthetic' } }])).toEqual([
      'synthetic-report-validation-only: pass requires version/account/profile/transport scoped live evidence',
    ]);
    expect(qualificationErrors([{ ...qualified, evidence: { ...qualified.evidence, profile: '' } }])).toHaveLength(1);
  });

  it('fails closed on malformed qualification reports', () => {
    expect(qualificationErrors(undefined)).toEqual(['qualificationResults must be an array']);
    expect(qualificationErrors([{ id: 'skipped', qualification: 'missing', result: 'skipped' }])).toHaveLength(1);
  });

  it.each(['valid', 'missing-qualification-pass', 'implemented-without-files'])('CLI exits and reports the intended %s result', scenario => {
    const directory = mkdtempSync(path.join(tmpdir(), 'aiwg-pack-gate-'));
    roots.push(directory);
    const value = registry();
    for (const pack of Object.values(value.packs) as any[]) {
      for (const file of pack.testFiles) {
        const destination = path.join(directory, file);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, "import { it } from 'vitest';\n");
      }
    }
    if (scenario === 'missing-qualification-pass') value.qualificationResults = [{ id: 'fake', qualification: 'missing', result: 'passed' }];
    if (scenario === 'implemented-without-files') value.packs['T-OG-06'].status = 'implemented';
    mkdirSync(path.dirname(path.join(directory, registryPath)), { recursive: true });
    writeFileSync(path.join(directory, registryPath), JSON.stringify(value));
    const script = `import { runPackGate } from ${JSON.stringify(checker)}; runPackGate({ repositoryRoot: ${JSON.stringify(directory)} });`;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 10_000 });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    const report = JSON.parse(readFileSync(path.join(directory, 'test-results/orchestration-pack-registry.json'), 'utf8'));
    expect(child.status).toBe(scenario === 'valid' ? 0 : 1);
    expect(report.result).toBe(scenario === 'valid' ? 'wiring-valid' : 'failed');
    expect(report.releaseQualification).toBe('unqualified');
    if (scenario === 'missing-qualification-pass') expect(report.errors).toContain('fake: missing qualification cannot be reported as a pass');
    if (scenario === 'implemented-without-files') expect(report.errors).toContain('T-OG-06: implemented without test files');
  });
});
