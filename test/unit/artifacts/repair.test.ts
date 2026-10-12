import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { repairProjectArtifacts } from '../../../src/artifacts/repair.js';

const roots: string[] = [];
function fixture() {
  const projectDir = mkdtempSync(join(tmpdir(), 'aiwg-artifact-repair-'));
  roots.push(projectDir); // registered immediately, before anything that could throw
  const artifactRoot = join(projectDir, 'external', '.aiwg');
  mkdirSync(join(artifactRoot, 'frameworks'), { recursive: true });
  writeFileSync(join(projectDir, '.aiwg-location'), 'external/.aiwg\n');
  writeFileSync(join(artifactRoot, 'AIWG.md'), '# AIWG\n');
  writeFileSync(join(artifactRoot, 'aiwg.config'), '{}\n');
  writeFileSync(join(artifactRoot, 'frameworks', 'registry.json'), '{}\n');
  return { projectDir, artifactRoot };
}

// Test isolation (#274 fix-round): `repairProjectArtifacts` audits with
// `env = process.env` by default, so an ambient AIWG_ARTIFACTS_PATH /
// AIWG_PROJECT_ARTIFACTS_PATH / AIWG_PROJECT_AIWG_DIR in the real
// environment (or a `~`-relative override resolved against the real
// HOME/USERPROFILE) could silently redirect artifact-root resolution away
// from each test's fixture. Stub all of them for the duration of this file.
const ISOLATED_ENV_KEYS = [
  'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR',
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ISOLATED_ENV_KEYS) savedEnv[key] = process.env[key];
  const fakeHome = mkdtempSync(join(tmpdir(), 'aiwg-artifact-repair-home-'));
  roots.push(fakeHome); // registered immediately, before anything that could throw
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.XDG_CONFIG_HOME = join(fakeHome, '.config');
  process.env.XDG_DATA_HOME = join(fakeHome, '.local', 'share');
  process.env.XDG_CACHE_HOME = join(fakeHome, '.cache');
  delete process.env.AIWG_ARTIFACTS_PATH;
  delete process.env.AIWG_PROJECT_ARTIFACTS_PATH;
  delete process.env.AIWG_PROJECT_AIWG_DIR;
});

afterEach(() => {
  for (const key of ISOLATED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('repairProjectArtifacts', () => {
  it('previews and then materializes a missing local control plane', async () => {
    const { projectDir } = fixture();
    const preview = await repairProjectArtifacts({ projectDir });
    expect(preview.applied).toBe(false);
    expect(preview.copied).toEqual(['AIWG.md', 'aiwg.config', 'frameworks/registry.json']);
    expect(existsSync(join(projectDir, '.aiwg', 'AIWG.md'))).toBe(false);

    const applied = await repairProjectArtifacts({ projectDir, apply: true });
    expect(applied.after.classification).toBe('healthy-split-root');
    expect(existsSync(join(projectDir, '.aiwg', 'AIWG.md'))).toBe(true);
  });

  it('removes only identical local corpus duplicates and refuses divergence', async () => {
    const { projectDir, artifactRoot } = fixture();
    await repairProjectArtifacts({ projectDir, apply: true });
    mkdirSync(join(projectDir, '.aiwg', 'requirements'), { recursive: true });
    mkdirSync(join(artifactRoot, 'requirements'), { recursive: true });
    writeFileSync(join(projectDir, '.aiwg', 'requirements', 'UC-1.md'), '# Same\n');
    writeFileSync(join(artifactRoot, 'requirements', 'UC-1.md'), '# Same\n');
    const repaired = await repairProjectArtifacts({ projectDir, apply: true });
    expect(repaired.removed).toEqual(['requirements/UC-1.md']);
    expect(existsSync(join(projectDir, '.aiwg', 'requirements', 'UC-1.md'))).toBe(false);

    writeFileSync(join(projectDir, '.aiwg', 'AIWG.md'), '# Diverged\n');
    await expect(repairProjectArtifacts({ projectDir, apply: true })).rejects.toThrow(/diverges/);
  });

  it('migrates new payload and archives divergent local variants without data loss', async () => {
    const { projectDir, artifactRoot } = fixture();
    await repairProjectArtifacts({ projectDir, apply: true });
    mkdirSync(join(projectDir, '.aiwg', 'research'), { recursive: true });
    mkdirSync(join(artifactRoot, 'research'), { recursive: true });
    writeFileSync(join(projectDir, '.aiwg', 'research', 'new.md'), '# Local only\n');
    writeFileSync(join(projectDir, '.aiwg', 'research', 'divergent.md'), '# Local variant\n');
    writeFileSync(join(artifactRoot, 'research', 'divergent.md'), '# External variant\n');

    const preview = await repairProjectArtifacts({ projectDir });
    expect(preview.migrated).toEqual(['research/new.md']);
    expect(preview.archivedConflicts).toHaveLength(1);
    expect(preview.archivedConflicts[0]).toMatch(/^archive\/local-corpus-migration\/conflicts\/local\/research\/divergent\.md\.[a-f0-9]{12}$/);
    expect(existsSync(join(projectDir, '.aiwg', 'research', 'new.md'))).toBe(true);

    const applied = await repairProjectArtifacts({ projectDir, apply: true });
    expect(applied.after.classification).toBe('healthy-split-root');
    expect(existsSync(join(projectDir, '.aiwg', 'research', 'new.md'))).toBe(false);
    expect(existsSync(join(projectDir, '.aiwg', 'research', 'divergent.md'))).toBe(false);
    expect(readFileSync(join(artifactRoot, 'research', 'new.md'), 'utf8')).toBe('# Local only\n');
    expect(readFileSync(join(artifactRoot, 'research', 'divergent.md'), 'utf8')).toBe('# External variant\n');
    expect(readFileSync(join(artifactRoot, applied.archivedConflicts[0]), 'utf8')).toBe('# Local variant\n');
  });

  // #274 — repair must refuse local mode (no external root configured)
  // before auditing, not after scanning the full local payload.
  //
  // Proven with a sentinel rather than `chmod 000` on the payload
  // directory: chmod is a no-op for the root user and is not reliably
  // enforced on every platform/filesystem, so a chmod-based assertion can
  // pass vacuously in CI. The sentinel instead makes `readdir` throw
  // unconditionally for that specific directory — the pre-fix code calls
  // `auditProjectArtifactHealth()` (which lists the whole local payload)
  // before checking `external_configured`, so it would surface that
  // EACCES error instead of the intended "no external corpus" refusal,
  // regardless of which user or OS runs the test.
  it('refuses local mode before auditing, even when the local payload is unreadable', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'aiwg-artifact-repair-local-'));
    roots.push(projectDir);
    mkdirSync(join(projectDir, '.aiwg', 'frameworks'), { recursive: true });
    writeFileSync(join(projectDir, '.aiwg', 'AIWG.md'), '# AIWG\n');
    writeFileSync(join(projectDir, '.aiwg', 'aiwg.config'), '{}\n');
    writeFileSync(join(projectDir, '.aiwg', 'frameworks', 'registry.json'), '{}\n');
    const sentinelDir = join(projectDir, '.aiwg', 'requirements');
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(join(sentinelDir, 'UC-1.md'), '# Requirement\n');

    const realReaddirSync = fs.readdirSync.bind(fs);
    const readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
      if (String(args[0]) === sentinelDir) {
        throw Object.assign(new Error(`EACCES: permission denied, scandir '${sentinelDir}'`), { code: 'EACCES' });
      }
      // @ts-expect-error — overload spread passthrough to the real implementation
      return realReaddirSync(...args);
    }) as typeof fs.readdirSync);

    try {
      await expect(repairProjectArtifacts({ projectDir })).rejects.toThrow(
        'No external AIWG artifact corpus is configured for this project.',
      );
    } finally {
      readdirSpy.mockRestore();
    }
  });
});
