/**
 * UAT: CX-001 — generated context carries the dispatch state and check-in rules
 *
 * Three scratch projects:
 *   (a) `parallelism.worker_dispatch: true`
 *   (b) dispatch absent/false, no prior offer
 *   (c) dispatch off and `setup.worker_dispatch_offer: "declined"`
 *
 * `aiwg regenerate` in each; the generated `AIWG.md` must carry the exact
 * dispatch-state line per variant (src/smiths/context-pipeline/
 * parallelism-section.ts). That function (`workerDispatchStateLine`) is not
 * exported, so assertions below are on the stable key phrases quoted
 * verbatim from its source rather than an imported constant — flagged
 * inline at each assertion.
 *
 * Run on demand (included in npm run uat):
 *   npm run uat
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildHermeticEnv, runAiwgCli, missingBuiltCli, REPO_ROOT } from './helpers/hermetic-cli.js';

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readAiwgConfig(projectDir: string): any {
  return JSON.parse(readFileSync(join(projectDir, '.aiwg', 'aiwg.config'), 'utf-8'));
}

function writeAiwgConfig(projectDir: string, config: any): void {
  writeFileSync(join(projectDir, '.aiwg', 'aiwg.config'), JSON.stringify(config, null, 2));
}

describe.skipIf(missingBuiltCli())('UAT: CX-001 — generated context carries the dispatch state line', () => {
  let projectDir: string;
  let configDir: string;

  beforeEach(() => {
    projectDir = makeTmpDir('aiwg-uat-cx001-proj-');
    configDir = makeTmpDir('aiwg-uat-cx001-config-');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  async function initAndRegenerate(): Promise<Record<string, string>> {
    const env = await buildHermeticEnv({ aiwgConfig: configDir, extra: { AIWG_HOME: REPO_ROOT } });
    expect(runAiwgCli(['init', '--non-interactive'], { cwd: projectDir, env }).status).toBe(0);
    return env;
  }

  it('variant (a) dispatch on: the "on" state line and the orchestration-groups section are present', async () => {
    const env = await initAndRegenerate();
    const config = readAiwgConfig(projectDir);
    config.parallelism = {
      worker_dispatch: true,
      clis: { claude: { adapter: 'providers:claude', accountScope: 'local-account', quotaScope: 'uat-cx001' } },
      groups: { g1: { members: [{ id: 'm1', cli: 'claude', model: 'claude-uat', roles: ['efficiency'] }] } },
    };
    writeAiwgConfig(projectDir, config);

    expect(runAiwgCli(['regenerate', '--workspace'], { cwd: projectDir, env }).status).toBe(0);
    const aiwgMd = readFileSync(join(projectDir, 'AIWG.md'), 'utf-8');

    // Exact state line, verified at src/smiths/context-pipeline/parallelism-section.ts:143.
    expect(aiwgMd).toContain('**Direct worker dispatch**: on (`parallelism.worker_dispatch`).');
    // Exact heading, verified at src/smiths/context-pipeline/parallelism-section.ts:278.
    expect(aiwgMd).toContain('### Orchestration groups (group dispatch enabled)');
  });

  it('variant (b) dispatch off, no prior offer: the detect-and-offer sentence and enable command are present', async () => {
    const env = await initAndRegenerate();

    expect(runAiwgCli(['regenerate', '--workspace'], { cwd: projectDir, env }).status).toBe(0);
    const aiwgMd = readFileSync(join(projectDir, 'AIWG.md'), 'utf-8');

    expect(aiwgMd).toContain('**Direct worker dispatch**: off (`parallelism.worker_dispatch`).');
    expect(aiwgMd).toContain('Do not assume other worker CLIs are unavailable — detect them yourself and offer');
    expect(aiwgMd).toContain('aiwg config set --project parallelism.worker_dispatch true');
  });

  it('variant (c) dispatch off and declined: carries the sticky-decline wording, omits the detect-and-offer sentence', async () => {
    const env = await initAndRegenerate();
    const config = readAiwgConfig(projectDir);
    config.setup = { worker_dispatch_offer: 'declined' };
    writeAiwgConfig(projectDir, config);

    expect(runAiwgCli(['regenerate', '--workspace'], { cwd: projectDir, env }).status).toBe(0);
    const aiwgMd = readFileSync(join(projectDir, 'AIWG.md'), 'utf-8');

    expect(aiwgMd).toContain('a prior offer was declined');
    expect(aiwgMd).toContain('Do not re-offer it.');
    expect(aiwgMd).not.toContain('Do not assume other worker CLIs are unavailable — detect them yourself and offer');
  });
});
