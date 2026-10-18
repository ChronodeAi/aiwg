import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { guard } = vi.hoisted(() => ({ guard: vi.fn(() => false) }));
vi.mock('../../../tools/_is-main.mjs', () => ({ isMain: guard }));
vi.mock('readline', () => ({ createInterface: () => ({ close: vi.fn(), question: vi.fn() }) }));

const scripts = [
  'cli/deploy.mjs',
  'cli/doctor.mjs',
  'contrib/abort-contribution.mjs',
  'contrib/create-pr.mjs',
  'contrib/start-contribution.mjs',
  'contrib/status-contribution.mjs',
  'contrib/sync-upstream.mjs',
];

describe('script main guards', () => {
  let root;
  let originalArgv;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'aiwg-main-guard-'));
    originalArgv = process.argv;
    guard.mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
    rmSync(root, { recursive: true, force: true });
  });

  it.each(scripts)('uses the shared guard for %s without running main on import', async (script) => {
    const file = path.resolve('tools', script);
    await import(file);
    expect(guard).toHaveBeenCalledWith(pathToFileURL(file).href);
  });

  it.each(scripts)('matches %s through a symlinked installation root', async (script) => {
    const { isMain } = await vi.importActual('../../../tools/_is-main.mjs');
    symlinkSync(path.resolve('tools'), path.join(root, 'linked-tools'), 'junction');
    process.argv = [process.execPath, path.join(root, 'linked-tools', script)];
    expect(isMain(pathToFileURL(path.resolve('tools', script)).href)).toBe(true);
  });

  it('returns false for a different entry point, missing files and absent argv', async () => {
    const { isMain } = await vi.importActual('../../../tools/_is-main.mjs');
    const moduleUrl = pathToFileURL(path.resolve('tools/contrib/status-contribution.mjs')).href;
    process.argv = [process.execPath, path.resolve('tools/contrib/create-pr.mjs')];
    expect(isMain(moduleUrl)).toBe(false);
    process.argv = [process.execPath, path.join(root, 'missing.mjs')];
    expect(isMain(moduleUrl)).toBe(false);
    process.argv = [process.execPath];
    expect(isMain(moduleUrl)).toBe(false);
  });

  it('runs status through a symlinked root with real output and a failing status', () => {
    symlinkSync(path.resolve('.'), path.join(root, 'installation'), 'junction');
    const result = spawnSync(process.execPath, [
      path.join(root, 'installation/tools/contrib/status-contribution.mjs'), 'missing-feature',
    ], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('Contribution workspace not found');
  });
});
