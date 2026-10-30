/**
 * UAT: WD-002 — the dispatch gate honours `parallelism.worker_dispatch: false`
 *
 * Plan criterion: with `worker_dispatch: false`, `aiwg models resolve
 * --task ... --group ... --transport shell --format shell` exits non-zero
 * with a diagnostic naming `parallelism.worker_dispatch` and the enable
 * command, and a configured worker executable (a fake CLI that would
 * append to a sentinel file if invoked) is never run.
 *
 * Regression coverage for #3070: dispatch off is explained before requiring
 * a qualified installation, including on a fresh project.
 *
 * Run on demand (included in npm run uat):
 *   npm run uat
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildHermeticEnv, runAiwgCli, missingBuiltCli, REPO_ROOT } from './helpers/hermetic-cli.js';
import { writeExecutableSync } from '../helpers/write-executable.js';

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe.skipIf(missingBuiltCli())('UAT: WD-002 — worker_dispatch: false blocks dispatch and never runs the worker', () => {
  let projectDir: string;
  let configDir: string;
  let sentinelFile: string;
  let fakeClaudePath: string;

  beforeEach(() => {
    projectDir = makeTmpDir('aiwg-uat-wd002-proj-');
    configDir = makeTmpDir('aiwg-uat-wd002-config-');
    const binDir = join(projectDir, 'bin');
    mkdirSync(binDir);
    sentinelFile = join(binDir, 'sentinel-worker-ran.txt');
    fakeClaudePath = join(binDir, 'fake-claude');
    // If this were ever invoked, it would prove dispatch happened — it must
    // not be: the dispatch gate is asserted entirely by this file's absence.
    writeExecutableSync(fakeClaudePath, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(sentinelFile)}, 'ran');\n`);

    mkdirSync(join(projectDir, '.aiwg'), { recursive: true });
    mkdirSync(join(projectDir, 'workdir'), { recursive: true });
    writeFileSync(join(projectDir, 'brief.txt'), 'print the string ok');
    writeFileSync(join(projectDir, '.aiwg', 'aiwg.config'), JSON.stringify({
      version: '1',
      providers: ['claude'],
      parallelism: {
        worker_dispatch: false,
        clis: {
          claude: {
            adapter: 'providers:claude', accountScope: 'local-account',
            quotaScope: 'uat-wd002-scope', executable: fakeClaudePath,
          },
        },
        groups: {
          g1: { members: [{ id: 'm1', cli: 'claude', model: 'claude-uat', roles: ['efficiency'] }] },
        },
      },
    }, null, 2));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  function resolveArgs(): string[] {
    return [
      'models', 'resolve',
      '--role', 'efficiency', '--task', 'uat-wd002-task', '--group', 'g1',
      '--brief', join(projectDir, 'brief.txt'),
      '--workdir', join(projectDir, 'workdir'),
      '--final-output', join(projectDir, 'final.json'),
      '--transport', 'shell', '--format', 'shell',
    ];
  }

  it('exits non-zero and never invokes the configured worker executable', async () => {
    // `models resolve`'s AIWG-default model config is read from AIWG_HOME,
    // unlike the context-pipeline generators (which fall back to the
    // running package's own bundled defaults) — see
    // src/models/config-loader.ts ConfigLoader constructor.
    const env = await buildHermeticEnv({ aiwgConfig: configDir, extra: { AIWG_HOME: REPO_ROOT } });
    const result = runAiwgCli(resolveArgs(), { cwd: projectDir, env });

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(existsSync(sentinelFile), 'the configured worker executable must never run').toBe(false);

    const parsed = JSON.parse(result.stderr || result.stdout);
    expect(parsed.status).toBe('blocked');
  });

  // #3070: fresh projects get the dispatch-off reason before installation qualification.
  it('blocked diagnostic names parallelism.worker_dispatch and the enable command', async () => {
    const { WORKER_DISPATCH_ENABLE_COMMAND } = await import('../../src/models/worker-dispatch-offer.js');
    const env = await buildHermeticEnv({ aiwgConfig: configDir, extra: { AIWG_HOME: REPO_ROOT } });
    const result = runAiwgCli(resolveArgs(), { cwd: projectDir, env });

    const parsed = JSON.parse(result.stderr || result.stdout);
    const rendered = JSON.stringify(parsed);
    expect(rendered).toContain('parallelism.worker_dispatch');
    expect(rendered).toContain(WORKER_DISPATCH_ENABLE_COMMAND);
  });
});
