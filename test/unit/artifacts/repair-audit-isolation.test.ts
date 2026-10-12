/**
 * #274 fix-round — direct assertion that local-mode repair never invokes the
 * audit function at all, not just an inference from "no payload was read".
 *
 * Isolated into its own file because it mocks `src/config/project-artifacts.js`
 * module-wide (wrapping the real `auditProjectArtifactHealth` in a spy); other
 * repair tests (test/unit/artifacts/repair.test.ts) need the real, unmocked
 * audit behavior for their external-mode integration assertions.
 *
 * HOME/XDG and artifact-path override isolation: every fixture lives under a
 * stubbed HOME/USERPROFILE/XDG_* so no test can read or write the operator's
 * real home directory, and `AIWG_ARTIFACTS_PATH` / `AIWG_PROJECT_ARTIFACTS_PATH`
 * / `AIWG_PROJECT_AIWG_DIR` are cleared so ambient environment cannot silently
 * select an external root. Cleanup is registered immediately after each
 * temp-directory is created, before any setup that could throw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../../src/config/project-artifacts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/project-artifacts.js')>();
  return {
    ...actual,
    auditProjectArtifactHealth: vi.fn(
      (...args: Parameters<typeof actual.auditProjectArtifactHealth>) => actual.auditProjectArtifactHealth(...args),
    ),
  };
});

const roots: string[] = [];
let savedEnv: Record<string, string | undefined>;

const ENV_KEYS = [
  'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR',
] as const;

beforeEach(async () => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  const { auditProjectArtifactHealth } = await import('../../../src/config/project-artifacts.js');
  vi.mocked(auditProjectArtifactHealth).mockClear();
  // Stub HOME/USERPROFILE/XDG_* so nothing in this suite can touch the real
  // home directory, and clear artifact-path overrides so ambient environment
  // cannot silently select an external root behind the test's back.
  const fakeHome = mkdtempSync(join(tmpdir(), 'aiwg-repair-audit-isolation-home-'));
  roots.push(fakeHome);
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
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function makeProjectDir(): string {
  const projectDir = mkdtempSync(join(tmpdir(), 'aiwg-repair-audit-isolation-project-'));
  roots.push(projectDir); // registered immediately, before any further setup
  return projectDir;
}

describe('repairProjectArtifacts: local-mode audit isolation (#274 fix-round)', () => {
  it('never invokes auditProjectArtifactHealth at all in local mode', async () => {
    const { repairProjectArtifacts } = await import('../../../src/artifacts/repair.js');
    const projectDir = makeProjectDir();
    mkdirSync(join(projectDir, '.aiwg', 'frameworks'), { recursive: true });
    writeFileSync(join(projectDir, '.aiwg', 'AIWG.md'), '# AIWG\n');
    writeFileSync(join(projectDir, '.aiwg', 'aiwg.config'), '{}\n');
    writeFileSync(join(projectDir, '.aiwg', 'frameworks', 'registry.json'), '{}\n');

    await expect(repairProjectArtifacts({ projectDir })).rejects.toThrow(
      'No external AIWG artifact corpus is configured for this project.',
    );

    const { auditProjectArtifactHealth } = await import('../../../src/config/project-artifacts.js');
    expect(auditProjectArtifactHealth).not.toHaveBeenCalled();
  });

  it('sanity check: external mode does invoke the audit (proves the spy itself is wired correctly)', async () => {
    const { repairProjectArtifacts } = await import('../../../src/artifacts/repair.js');
    const projectDir = makeProjectDir();
    const artifactRoot = join(projectDir, 'external', '.aiwg');
    mkdirSync(join(artifactRoot, 'frameworks'), { recursive: true });
    writeFileSync(join(projectDir, '.aiwg-location'), 'external/.aiwg\n');
    writeFileSync(join(artifactRoot, 'AIWG.md'), '# AIWG\n');
    writeFileSync(join(artifactRoot, 'aiwg.config'), '{}\n');
    writeFileSync(join(artifactRoot, 'frameworks', 'registry.json'), '{}\n');

    const result = await repairProjectArtifacts({ projectDir });
    expect(result.applied).toBe(false);
    const { auditProjectArtifactHealth } = await import('../../../src/config/project-artifacts.js');
    expect(auditProjectArtifactHealth).toHaveBeenCalledTimes(1);
  });
});
