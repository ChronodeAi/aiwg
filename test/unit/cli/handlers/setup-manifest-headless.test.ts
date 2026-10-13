/**
 * `aiwg setup-run` headless safety (#3062).
 *
 * Without a terminal, manifest-author-defined shell commands and scripts
 * must never be allowed to hang waiting for input nobody can supply: they
 * run bounded (long tier, stdin ignored) instead of with inherited stdio.
 * A step marked `interactive: true` is refused up front instead of being
 * run at all. With a terminal, behavior is unchanged.
 */

import { writeExecutableSync } from '../../../helpers/write-executable.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

const { mockIsInteractive, spawnSyncCalls } = vi.hoisted(() => ({
  mockIsInteractive: vi.fn(),
  spawnSyncCalls: [] as Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }>,
}));

vi.mock('../../../../src/cli/env.js', () => ({ isInteractive: mockIsInteractive }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    // This capturing wrapper is itself a synchronous child-process call, so
    // tools/testing/check-sync-child-process-timeouts.mjs scans it too: give
    // it a literal fallback timeout (the gate only recognizes an inline
    // object literal) that the real `options.timeout` — set by the
    // bounded-child-process helper or the raw-spawnSync call under test —
    // overrides via the spread.
    spawnSync: (command: string, args: readonly string[], options: Record<string, unknown>) => {
      spawnSyncCalls.push({ command, args, options });
      return actual.spawnSync(command, args, { timeout: 60_000, ...options });
    },
  };
});

import { runSetupManifest } from '../../../../src/cli/handlers/setup-manifest.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

function writeExecutable(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeExecutableSync(filePath, body);
}

function writeManifest(tmpDir: string, manifest: Record<string, unknown>): string {
  const manifestPath = path.join(tmpDir, 'setup.manifest.yaml');
  fs.writeFileSync(manifestPath, stringify(manifest), 'utf8');
  return manifestPath;
}

function baseManifest(steps: Record<string, unknown>[]) {
  return {
    apiVersion: 'setup.aiwg.io/v1',
    kind: 'SetupManifest',
    metadata: { name: 'sample', description: 'no os configuration required', install_type: 'developer' },
    spec: { platforms: [{ os: 'linux' }], steps },
  };
}

describe('setup-run headless safety (#3062)', () => {
  let tmpDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-setup-manifest-headless-'));
    spawnSyncCalls.length = 0;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs a script step bounded with stdin ignored when no terminal is attached', () => {
    mockIsInteractive.mockReturnValue(false);
    const marker = path.join(tmpDir, 'marker');
    writeExecutable(path.join(tmpDir, 'scripts/install.sh'), `#!/usr/bin/env sh\nprintf ran > ${marker}\n`);
    writeManifest(tmpDir, baseManifest([{ id: 'install', type: 'script', script: 'scripts/install.sh' }]));

    const result = runSetupManifest({
      cwd: tmpDir, frameworkRoot: REPO_ROOT, platform: 'linux', paramValues: {}, skip: new Set(), yes: true,
    });

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(marker, 'utf8')).toBe('ran');
    const scriptCall = spawnSyncCalls.find((c) => c.command.endsWith('install.sh'));
    expect(scriptCall).toBeDefined();
    expect(scriptCall!.options.timeout).toBeGreaterThan(0);
    const stdio = scriptCall!.options.stdio as unknown[];
    expect(stdio[0]).toBe('ignore');
  });

  it('runs a script step unbounded (inherited stdio) when a terminal is attached', () => {
    mockIsInteractive.mockReturnValue(true);
    const marker = path.join(tmpDir, 'marker');
    writeExecutable(path.join(tmpDir, 'scripts/install.sh'), `#!/usr/bin/env sh\nprintf ran > ${marker}\n`);
    writeManifest(tmpDir, baseManifest([{ id: 'install', type: 'script', script: 'scripts/install.sh' }]));

    const result = runSetupManifest({
      cwd: tmpDir, frameworkRoot: REPO_ROOT, platform: 'linux', paramValues: {}, skip: new Set(), yes: true,
    });

    expect(result.exitCode).toBe(0);
    const scriptCall = spawnSyncCalls.find((c) => c.command.endsWith('install.sh'));
    expect(scriptCall).toBeDefined();
    expect(scriptCall!.options.timeout).toBeUndefined();
    expect(scriptCall!.options.stdio).toBe('inherit');
  });

  it('runs a verify/detect shell command bounded with stdin ignored when no terminal is attached', () => {
    mockIsInteractive.mockReturnValue(false);
    writeManifest(tmpDir, baseManifest([{ id: 'check', type: 'verify', commands: ['true'] }]));

    const result = runSetupManifest({
      cwd: tmpDir, frameworkRoot: REPO_ROOT, platform: 'linux', paramValues: {}, skip: new Set(), yes: true,
    });

    expect(result.exitCode).toBe(0);
    const shellCall = spawnSyncCalls.find((c) => c.command === 'true');
    expect(shellCall).toBeDefined();
    expect(shellCall!.options.timeout).toBeGreaterThan(0);
    const stdio = shellCall!.options.stdio as unknown[];
    expect(stdio[0]).toBe('ignore');
  });

  it('refuses a step marked interactive: true without a terminal, before running it', () => {
    mockIsInteractive.mockReturnValue(false);
    const marker = path.join(tmpDir, 'marker');
    writeExecutable(path.join(tmpDir, 'scripts/install.sh'), `#!/usr/bin/env sh\nprintf ran > ${marker}\n`);
    writeManifest(tmpDir, baseManifest([{ id: 'install', type: 'script', script: 'scripts/install.sh', interactive: true }]));

    spawnSyncCalls.length = 0; // discard the writeExecutable() helper's own /bin/sh call above
    const result = runSetupManifest({
      cwd: tmpDir, frameworkRoot: REPO_ROOT, platform: 'linux', paramValues: {}, skip: new Set(), yes: true,
    });

    expect(result.exitCode).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    expect(spawnSyncCalls).toHaveLength(0);
    expect(consoleErrorSpy.mock.calls.flat().join(' ')).toContain("step 'install'");
  });

  it('runs a step marked interactive: true normally when a terminal is attached', () => {
    mockIsInteractive.mockReturnValue(true);
    const marker = path.join(tmpDir, 'marker');
    writeExecutable(path.join(tmpDir, 'scripts/install.sh'), `#!/usr/bin/env sh\nprintf ran > ${marker}\n`);
    writeManifest(tmpDir, baseManifest([{ id: 'install', type: 'script', script: 'scripts/install.sh', interactive: true }]));

    const result = runSetupManifest({
      cwd: tmpDir, frameworkRoot: REPO_ROOT, platform: 'linux', paramValues: {}, skip: new Set(), yes: true,
    });

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(marker, 'utf8')).toBe('ran');
  });
});
