/**
 * UAT: IN-002 — `refresh`, `regenerate` and `doctor --probe-workers` hint
 * but never silently enable direct worker dispatch
 *
 * Two scratch projects:
 *   - project 1: dispatch off, no prior offer, two fake worker CLIs
 *     detected on a fully constructed PATH (never the real host's).
 *   - project 2: dispatch off, `setup.worker_dispatch_offer: "declined"`.
 *
 * Each of `aiwg regenerate`, `aiwg refresh`, `aiwg doctor --probe-workers`
 * is run in both. Project 1 must print exactly one hint line per command
 * naming the enable command; project 2 must print none. In both cases the
 * project config is byte-unchanged (hashed before/after).
 *
 * Run on demand (included in npm run uat):
 *   npm run uat
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { writeExecutableSync } from '../helpers/write-executable.js';
import { buildHermeticEnv, runAiwgCli, missingBuiltCli, REPO_ROOT } from './helpers/hermetic-cli.js';

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** Count how many lines in `output` contain `needle`. */
function countLines(output: string, needle: string): number {
  return output.split('\n').filter((line) => line.includes(needle)).length;
}

describe.skipIf(missingBuiltCli())('UAT: IN-002 — dispatch hints never silently enable, and fire only when detection warrants them', () => {
  let binDir: string;
  let fakeWorkerNames: string[];

  beforeEach(async () => {
    binDir = makeTmpDir('aiwg-uat-in002-bin-');
    // Two known worker-CLI executable names, read from the product's own
    // registry at run time (never hard-coded), given fake, non-functional
    // implementations under a scratch bin directory that is the *only*
    // thing this suite puts ahead of system PATH — so detection reflects
    // exactly these two fakes, never whatever this host happens to have
    // installed.
    // @ts-ignore
    const { knownWorkerCliExecutables } = await import(join(REPO_ROOT, 'src/models/worker-dispatch-offer.js'));
    fakeWorkerNames = knownWorkerCliExecutables().slice(0, 2);
    expect(fakeWorkerNames.length).toBe(2);
    for (const name of fakeWorkerNames) {
      writeExecutableSync(join(binDir, name), '#!/usr/bin/env node\nprocess.exit(0);\n');
    }
  });

  afterEach(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  async function hermeticEnv(configDir: string) {
    return buildHermeticEnv({ pathDirs: [binDir], aiwgConfig: configDir, extra: { AIWG_HOME: REPO_ROOT } });
  }

  describe('project 1: dispatch off, no prior offer, two worker CLIs detected', () => {
    let projectDir: string;
    let configDir: string;

    beforeEach(() => {
      projectDir = makeTmpDir('aiwg-uat-in002-proj1-');
      configDir = makeTmpDir('aiwg-uat-in002-config1-');
    });

    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    });

    it('regenerate, refresh, and doctor --probe-workers each print exactly one hint, config byte-unchanged', async () => {
      const env = await hermeticEnv(configDir);
      expect(runAiwgCli(['init', '--non-interactive'], { cwd: projectDir, env }).status).toBe(0);

      const configPath = join(projectDir, '.aiwg', 'aiwg.config');
      const hashBefore = hashFile(configPath);

      const regenerate = runAiwgCli(['regenerate', '--workspace'], { cwd: projectDir, env });
      expect(regenerate.status).toBe(0);
      expect(countLines(regenerate.stdout, 'aiwg config set --project parallelism.worker_dispatch true')).toBe(1);

      const refresh = runAiwgCli(['refresh', '--dry-run'], { cwd: projectDir, env });
      expect(refresh.status).toBe(0);
      expect(countLines(refresh.stdout, 'aiwg config set --project parallelism.worker_dispatch true')).toBe(1);

      const doctor = runAiwgCli(['doctor', '--probe-workers'], { cwd: projectDir, env });
      expect(countLines(doctor.stdout, 'aiwg config set --project parallelism.worker_dispatch true')).toBe(1);

      expect(hashFile(configPath)).toBe(hashBefore);
    });
  });

  describe('project 2: dispatch off, prior offer declined', () => {
    let projectDir: string;
    let configDir: string;

    beforeEach(() => {
      projectDir = makeTmpDir('aiwg-uat-in002-proj2-');
      configDir = makeTmpDir('aiwg-uat-in002-config2-');
    });

    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    });

    it('regenerate, refresh, and doctor --probe-workers print no hint, config byte-unchanged', async () => {
      const env = await hermeticEnv(configDir);
      expect(runAiwgCli(['init', '--non-interactive'], { cwd: projectDir, env }).status).toBe(0);

      const configPath = join(projectDir, '.aiwg', 'aiwg.config');
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      config.setup = { worker_dispatch_offer: 'declined' };
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      const hashBefore = hashFile(configPath);

      const regenerate = runAiwgCli(['regenerate', '--workspace'], { cwd: projectDir, env });
      expect(regenerate.status).toBe(0);
      expect(countLines(regenerate.stdout, 'aiwg config set --project parallelism.worker_dispatch true')).toBe(0);

      const refresh = runAiwgCli(['refresh', '--dry-run'], { cwd: projectDir, env });
      expect(refresh.status).toBe(0);
      expect(countLines(refresh.stdout, 'aiwg config set --project parallelism.worker_dispatch true')).toBe(0);

      const doctor = runAiwgCli(['doctor', '--probe-workers'], { cwd: projectDir, env });
      expect(countLines(doctor.stdout, 'aiwg config set --project parallelism.worker_dispatch true')).toBe(0);

      expect(hashFile(configPath)).toBe(hashBefore);
    });
  });
});
