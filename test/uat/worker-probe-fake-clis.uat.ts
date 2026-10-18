/**
 * UAT: WD-001 — `doctor --probe-workers` readiness matches fixture reality
 *
 * Opt-in lane (see config/vitest.uat-workers-live.config.js): run with
 *   npm run uat:workers-live
 *
 * Points a scratch project's `parallelism.clis` at three fake, non-network
 * worker CLI scripts this suite writes itself — present-in-range, absent,
 * and out-of-range — and asserts `aiwg doctor --probe-workers` reports the
 * correct install-readiness verdict and reason for each, with the
 * per-executable "about to run" announcement appearing before its finding.
 * A fourth, separate project exercises the no-CLIs-configured case.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeExecutableSync } from '../helpers/write-executable.js';
import { buildHermeticEnv, runAiwgCli, missingBuiltCli, REPO_ROOT } from './helpers/hermetic-cli.js';

const REQUIRED = process.env.AIWG_UAT_WORKERS_LIVE_REQUIRED === '1';

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function trackedTmpDir(prefix: string): string {
  const dir = makeTmpDir(prefix);
  cleanupDirs.push(dir);
  return dir;
}

/** A fake CLI that prints `banner` on stdout for `--version` and exits 0. */
function writeFakeCli(filePath: string, banner: string): void {
  writeExecutableSync(filePath, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${banner}\n`)});\nprocess.exit(0);\n`);
}

// Strict local/release mode: set AIWG_UAT_WORKERS_LIVE_REQUIRED=1 (the
// `uat:workers-live` npm script does this) to fail instead of silently
// skip when `dist/` has not been built. Nothing else about this lane
// depends on host state to skip around — every CLI here is a fixture this
// suite writes itself.
describe(missingBuiltCli() && REQUIRED ? 'UAT: WD-001 — direct-worker readiness matrix against fake CLIs (dist/ missing — run npm run build:cli first)' : 'UAT: WD-001 — direct-worker readiness matrix against fake CLIs', () => {
  it.skipIf(missingBuiltCli() && !REQUIRED)('reports ready / out-of-range / not-installed, each with its announce line before its finding', async () => {
    if (missingBuiltCli() && REQUIRED) throw new Error('dist/ is missing — run `npm run build:cli` before `npm run uat:workers-live`');
    const projectDir = trackedTmpDir('aiwg-uat-wd001-proj-');
    const configDir = trackedTmpDir('aiwg-uat-wd001-config-');
    const binDir = trackedTmpDir('aiwg-uat-wd001-bin-');

    // @ts-ignore
    const { loadProviderModelCapabilities } = await import(join(REPO_ROOT, 'src/models/provider-policy.js'));
    const registry = loadProviderModelCapabilities();
    const adapterFor = (id: string) => registry.providers[id].workerAdapter ?? registry.providers[id].workerHealthAdapter;

    // present-in-range: a banner matching claude's registered version
    // pattern and exactly its registered supported version.
    const claudeAdapter = adapterFor('claude');
    const claudePath = join(binDir, 'fake-claude');
    writeFakeCli(claudePath, `${claudeAdapter.supportedVersions} (Claude Code)`);

    // out-of-range: a banner matching codex's pattern but a version well
    // outside its registered supported range.
    const codexAdapter = adapterFor('codex');
    const codexPath = join(binDir, 'fake-codex');
    writeFakeCli(codexPath, 'codex-cli 0.1.0');

    // absent: a path that is never created.
    const musePath = join(binDir, 'nonexistent-muse');

    mkdirSync(join(projectDir, '.aiwg'), { recursive: true });
    writeFileSync(join(projectDir, '.aiwg', 'aiwg.config'), JSON.stringify({
      version: '1',
      providers: ['claude'],
      parallelism: {
        worker_dispatch: true,
        clis: {
          claude: { adapter: 'providers:claude', accountScope: 'local-account', quotaScope: 'uat-wd001', executable: claudePath },
          codex: { adapter: 'providers:codex', accountScope: 'local-account', quotaScope: 'uat-wd001', executable: codexPath },
          muse: { adapter: 'providers:muse', accountScope: 'local-account', quotaScope: 'uat-wd001', executable: musePath },
        },
      },
    }, null, 2));

    const env = await buildHermeticEnv({ pathDirs: [], aiwgConfig: configDir, extra: { AIWG_HOME: REPO_ROOT } });
    const result = runAiwgCli(['doctor', '--probe-workers'], { cwd: projectDir, env, timeoutMs: 30_000 });
    const lines = result.stdout.split('\n');
    const indexOf = (needle: string): number => lines.findIndex((line) => line.includes(needle));

    // (a) the announce line appears for each configured CLI, naming the
    // exact executable and versionArgv the registry declares — the format
    // itself is a literal in tools/cli/doctor.mjs, not an exported
    // constant, so this asserts the stable substrings (executable path,
    // "--version", cli id) rather than the full sentence.
    const announceClaude = indexOf(`about to run '${claudePath} --version' (cli 'claude')`);
    const announceCodex = indexOf(`about to run '${codexPath} --version' (cli 'codex')`);
    const announceMuse = indexOf(`about to run '${musePath} --version' (cli 'muse')`);
    expect(announceClaude, 'claude announce line').toBeGreaterThanOrEqual(0);
    expect(announceCodex, 'codex announce line').toBeGreaterThanOrEqual(0);
    expect(announceMuse, 'muse announce line').toBeGreaterThanOrEqual(0);

    // (b)/(c) install-readiness findings, keyed on the product's own stable
    // code identifiers (src/models/worker-direct-readiness.ts) — not
    // exported constants, so these are the literal codes from source.
    const readyClaude = indexOf('Direct Worker (claude): WORKER_DIRECT_READY');
    const outOfRangeCodex = indexOf('Direct Worker (codex): WORKER_DIRECT_VERSION_OUT_OF_RANGE');
    const notInstalledMuse = indexOf('Direct Worker (muse): WORKER_DIRECT_NOT_INSTALLED');
    expect(readyClaude, 'claude ready finding').toBeGreaterThanOrEqual(0);
    expect(outOfRangeCodex, 'codex out-of-range finding').toBeGreaterThanOrEqual(0);
    expect(notInstalledMuse, 'muse not-installed finding').toBeGreaterThanOrEqual(0);

    // The ready finding names the matched version; the out-of-range finding
    // names both the installed version and the registered range.
    expect(lines[readyClaude]).toContain(`version ${claudeAdapter.supportedVersions}`);
    expect(lines[outOfRangeCodex]).toContain('version 0.1.0');
    expect(lines[outOfRangeCodex]).toContain(`'${codexAdapter.supportedVersions}'`);

    // (d) each announce line precedes its own finding line.
    expect(announceClaude).toBeLessThan(readyClaude);
    expect(announceCodex).toBeLessThan(outOfRangeCodex);
    expect(announceMuse).toBeLessThan(notInstalledMuse);

    // Exercise the public CLI/handler boundary too: the script's JSON unit
    // checks cannot catch extra text appended by the router or handler.
    const json = runAiwgCli(['doctor', '--probe-workers', '--json'], { cwd: projectDir, env, timeoutMs: 30_000 });
    expect(json.status).toBe(0);
    const payload = JSON.parse(json.stdout);
    expect(payload.workersConfigured).toBe(true);
    expect(payload.workers).toHaveLength(3);
    expect(Object.fromEntries(payload.workers.map((worker: { cli: string; reason: string }) => [worker.cli, worker.reason])))
      .toEqual({ claude: 'WORKER_DIRECT_READY', codex: 'WORKER_DIRECT_VERSION_OUT_OF_RANGE', muse: 'WORKER_DIRECT_NOT_INSTALLED' });
  });

  // roctinam/aiwg#3066: with `worker_dispatch: true` and no
  // `parallelism.clis` / group members configured at all, the direct worker
  // readiness section renders one visible, actionable line instead of
  // silence, so an empty run cannot be mistaken for "all workers ready".
  it.skipIf(missingBuiltCli() && !REQUIRED)('no CLIs configured renders one visible Direct Worker empty-state line (#3066)', async () => {
    if (missingBuiltCli() && REQUIRED) throw new Error('dist/ is missing — run `npm run build:cli` before `npm run uat:workers-live`');
    const projectDir = trackedTmpDir('aiwg-uat-wd001-empty-proj-');
    const configDir = trackedTmpDir('aiwg-uat-wd001-empty-config-');

    mkdirSync(join(projectDir, '.aiwg'), { recursive: true });
    writeFileSync(join(projectDir, '.aiwg', 'aiwg.config'), JSON.stringify({
      version: '1', providers: ['claude'], parallelism: { worker_dispatch: true },
    }, null, 2));

    const env = await buildHermeticEnv({ pathDirs: [], aiwgConfig: configDir, extra: { AIWG_HOME: REPO_ROOT } });
    const result = runAiwgCli(['doctor', '--probe-workers'], { cwd: projectDir, env, timeoutMs: 30_000 });

    const lines = result.stdout.split('\n').filter(line => line.includes('Direct Worker'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('No worker CLIs are configured');
    expect(lines[0]).toContain('aiwg config set --project parallelism.clis.');
    const json = runAiwgCli(['doctor', '--probe-workers', '--json'], { cwd: projectDir, env, timeoutMs: 30_000 });
    expect(json.status).toBe(0);
    const payload = JSON.parse(json.stdout);
    expect(payload.workersConfigured).toBe(false);
    expect(payload.workers).toEqual([]);
    expect(payload.message).toContain('No worker CLIs are configured');
  });
});
