import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { auditProjectArtifactHealth } from '../../../src/config/project-artifacts.js';

const roots: string[] = [];

function fixture(): { project: string; external: string } {
  const project = mkdtempSync(join(tmpdir(), 'aiwg-artifact-health-'));
  const external = join(project, 'external', '.aiwg');
  roots.push(project);
  writeFileSync(join(project, '.aiwg-location'), 'external/.aiwg\n');
  return { project, external };
}

function controls(root: string, suffix = ''): void {
  mkdirSync(join(root, 'frameworks'), { recursive: true });
  writeFileSync(join(root, 'AIWG.md'), `# AIWG${suffix}\n`);
  writeFileSync(join(root, 'aiwg.config'), `{"version":"1${suffix}"}\n`);
  writeFileSync(join(root, 'frameworks', 'registry.json'), `{"version":"1${suffix}"}\n`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('auditProjectArtifactHealth', () => {
  it('classifies a healthy split root', () => {
    const { project, external } = fixture();
    controls(join(project, '.aiwg'));
    controls(external);
    mkdirSync(join(external, 'requirements'), { recursive: true });
    writeFileSync(join(external, 'requirements', 'UC-1.md'), '# Requirement\n');

    expect(auditProjectArtifactHealth(project, {})).toMatchObject({
      classification: 'healthy-split-root', severity: 'ok', external_reachable: true,
    });
  });

  it('classifies offline and missing-control-plane states', () => {
    const offline = fixture();
    controls(join(offline.project, '.aiwg'));
    expect(auditProjectArtifactHealth(offline.project, {}).classification).toBe('degraded-offline');

    const missing = fixture();
    controls(missing.external);
    expect(auditProjectArtifactHealth(missing.project, {})).toMatchObject({
      classification: 'legacy-missing-control-plane', repairable: true,
    });
  });

  it('distinguishes identical duplication from divergence', () => {
    const identical = fixture();
    controls(join(identical.project, '.aiwg'));
    controls(identical.external);
    mkdirSync(join(identical.project, '.aiwg', 'requirements'), { recursive: true });
    mkdirSync(join(identical.external, 'requirements'), { recursive: true });
    writeFileSync(join(identical.project, '.aiwg', 'requirements', 'UC-1.md'), '# Same\n');
    writeFileSync(join(identical.external, 'requirements', 'UC-1.md'), '# Same\n');
    expect(auditProjectArtifactHealth(identical.project, {}).classification).toBe('duplicated-identical');

    // Divergent *payload* is repairable: repair archives the local variant and
    // leaves the external one untouched. Reporting it as manual-only steered
    // operators into hand-migrating corpora (#2516).
    writeFileSync(join(identical.project, '.aiwg', 'requirements', 'UC-1.md'), '# Different\n');
    expect(auditProjectArtifactHealth(identical.project, {})).toMatchObject({
      classification: 'duplicated-divergent-payload', severity: 'warning', repairable: true,
    });
  });

  it('reserves the manual duplicated-divergent state for control-plane divergence', () => {
    const { project, external } = fixture();
    controls(join(project, '.aiwg'));
    controls(external, '-external');

    // `repairProjectArtifacts` refuses outright while control-plane files
    // diverge, so this is the one state whose guidance must stay manual.
    expect(auditProjectArtifactHealth(project, {})).toMatchObject({
      classification: 'duplicated-divergent', severity: 'error', repairable: false,
    });
    expect(auditProjectArtifactHealth(project, {}).divergent_control_files.sort())
      .toEqual(['AIWG.md', 'aiwg.config', 'frameworks/registry.json']);
  });

  it('keeps control-plane divergence dominant when payload also diverges', () => {
    const { project, external } = fixture();
    controls(join(project, '.aiwg'), '-local');
    controls(external, '-external');
    mkdirSync(join(project, '.aiwg', 'requirements'), { recursive: true });
    mkdirSync(join(external, 'requirements'), { recursive: true });
    writeFileSync(join(project, '.aiwg', 'requirements', 'UC-1.md'), '# Local\n');
    writeFileSync(join(external, 'requirements', 'UC-1.md'), '# External\n');

    const report = auditProjectArtifactHealth(project, {});
    expect(report.classification).toBe('duplicated-divergent');
    expect(report.repairable).toBe(false);
    expect(report.divergent_local_corpus_files).toEqual(['requirements/UC-1.md']);
  });

  // #274 — local mode (no external root configured) must never byte-compare
  // the local payload with itself. Previously `externalReachable` was true
  // in local mode (artifactRoot === localRoot, which exists), so every
  // payload file was read twice and compared with itself for nothing.
  describe('local mode (no external root configured)', () => {
    it('reports external_reachable=false and skips the payload scan entirely', () => {
      const project = mkdtempSync(join(tmpdir(), 'aiwg-artifact-health-local-'));
      roots.push(project);
      controls(join(project, '.aiwg'));
      mkdirSync(join(project, '.aiwg', 'requirements'), { recursive: true });
      writeFileSync(join(project, '.aiwg', 'requirements', 'UC-1.md'), '# Local only\n');

      const readSpy = vi.spyOn(fs, 'readFileSync');
      const readdirSpy = vi.spyOn(fs, 'readdirSync');
      try {
        const report = auditProjectArtifactHealth(project, {});
        expect(report.external_configured).toBe(false);
        expect(report.external_reachable).toBe(false);
        expect(report.classification).toBe('local');
        expect(report.duplicated_local_corpus_files).toEqual([]);
        expect(report.divergent_local_corpus_files).toEqual([]);
        // No payload file content was read, and the payload directory was
        // never listed — local mode has nothing to compare against.
        expect(readSpy).not.toHaveBeenCalled();
        expect(readdirSpy).not.toHaveBeenCalled();
      } finally {
        readSpy.mockRestore();
        readdirSpy.mockRestore();
      }
    });

    it('still succeeds when a local payload file is unreadable', () => {
      const project = mkdtempSync(join(tmpdir(), 'aiwg-artifact-health-local-unreadable-'));
      roots.push(project);
      controls(join(project, '.aiwg'));
      mkdirSync(join(project, '.aiwg', 'requirements'), { recursive: true });
      const unreadable = join(project, '.aiwg', 'requirements', 'UC-1.md');
      writeFileSync(unreadable, '# Local only\n');
      chmodSync(unreadable, 0o000);
      try {
        expect(() => auditProjectArtifactHealth(project, {})).not.toThrow();
        expect(auditProjectArtifactHealth(project, {}).classification).toBe('local');
      } finally {
        chmodSync(unreadable, 0o644);
      }
    });
  });
});
