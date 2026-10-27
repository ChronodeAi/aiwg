/**
 * Regression tests for #3635 finding 1: doctor discovery self-probes must run
 * the current entrypoint instead of the bare `aiwg` name, and only a
 * bare-name ENOENT reports "not on PATH".
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probeNotOnPathDetail,
  resolveAiwgProbeCommand,
} from '../../../src/process/aiwg-probe-command.mjs';

describe('resolveAiwgProbeCommand (#3635)', () => {
  it('prefers the AIWG_BIN override', () => {
    expect(
      resolveAiwgProbeCommand({ env: { AIWG_BIN: '/tmp/fake-aiwg/bin/aiwg' } }),
    ).toEqual({ file: '/tmp/fake-aiwg/bin/aiwg', prefix: [], via: 'aiwg-bin' });
  });

  it('resolves the current entrypoint so probes work when aiwg is not on PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiwg-probe-entrypoint-'));
    try {
      const entrypoint = join(dir, 'aiwg.mjs');
      writeFileSync(entrypoint, '#!/usr/bin/env node\n');
      expect(
        resolveAiwgProbeCommand({
          env: {},
          argv1: entrypoint,
          execPath: '/fake/node',
          cwd: dir,
        }),
      ).toEqual({ file: '/fake/node', prefix: [entrypoint], via: 'entrypoint' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the package bin/aiwg.mjs when the entrypoint is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiwg-probe-package-'));
    try {
      mkdirSync(join(dir, 'bin'), { recursive: true });
      const bin = join(dir, 'bin', 'aiwg.mjs');
      writeFileSync(bin, '#!/usr/bin/env node\n');
      expect(
        resolveAiwgProbeCommand({
          env: {},
          argv1: '/nonexistent-entrypoint.mjs',
          execPath: '/fake/node',
          cwd: dir,
          packageRoot: dir,
        }),
      ).toEqual({ file: '/fake/node', prefix: [bin], via: 'package' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the bare name when nothing resolves, with a not-on-PATH detail', () => {
    const resolved = resolveAiwgProbeCommand({
      env: {},
      argv1: '/nonexistent-entrypoint.mjs',
      execPath: '/fake/node',
      cwd: '/nonexistent-cwd',
      packageRoot: '/nonexistent-package-root',
    });
    expect(resolved).toEqual({ file: 'aiwg', prefix: [], via: 'path' });
    expect(probeNotOnPathDetail()).toMatch(/not on PATH/);
  });
  it('ignores a non-launcher script such as tools/cli/doctor.mjs and falls back to the package bin', () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-probe-doctor-'));
    try {
      mkdirSync(join(root, 'bin'), { recursive: true });
      mkdirSync(join(root, 'tools/cli'), { recursive: true });
      writeFileSync(join(root, 'bin', 'aiwg.mjs'), '');
      writeFileSync(join(root, 'tools/cli', 'doctor.mjs'), '');
      const resolved = resolveAiwgProbeCommand({ env: {}, argv1: join(root, 'tools/cli', 'doctor.mjs'),
        execPath: '/usr/bin/node', packageRoot: root });
      expect(resolved).toEqual({ file: '/usr/bin/node', prefix: [join(root, 'bin', 'aiwg.mjs')], via: 'package' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
