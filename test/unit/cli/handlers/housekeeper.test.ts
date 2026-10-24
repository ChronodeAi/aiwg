/**
 * Unit tests for the housekeeper CLI handler (epic #3353 slice B5).
 *
 * Covers help text, the status --json contract, strict flag parsing,
 * headless failures naming the flag, job/watch registration round-trips,
 * install --dry-run writing nothing, and duplicate-start prevention.
 * All state lives in temp dirs; no daemon is spawned and no systemd
 * units are installed (AIWG_HOUSEKEEPER_SYSTEMD_DIR points at temp).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';

const mockRun = vi.fn().mockResolvedValue({ exitCode: 0 });

vi.mock('../../../../src/cli/handlers/script-runner.js', () => ({
  createScriptRunner: vi.fn(() => ({ run: mockRun })),
}));

vi.mock('../../../../src/channel/manager.mjs', () => ({
  getFrameworkRoot: vi.fn().mockResolvedValue('/mock/framework/root'),
}));

import {
  housekeeperHandler,
  housekeeperHandlers,
  housekeeperHelpText,
} from '../../../../src/cli/handlers/housekeeper.js';
import { getFrameworkRoot } from '../../../../src/channel/manager.mjs';

let cwd: string;
let systemdDir: string;
let launchdDir: string;
let savedSystemdDir: string | undefined;
let savedLaunchdDir: string | undefined;

function makeCtx(args: string[]): HandlerContext {
  return { args, rawArgs: ['housekeeper', ...args], cwd, frameworkRoot: '/mock/framework/root' };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRun.mockResolvedValue({ exitCode: 0 });
  // The vitest config sets mockReset:true, which wipes vi.mock factory
  // implementations before each test — re-establish them here.
  vi.mocked(getFrameworkRoot).mockResolvedValue('/mock/framework/root');
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'housekeeper-cli-'));
  systemdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'housekeeper-systemd-'));
  launchdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'housekeeper-launchd-'));
  savedSystemdDir = process.env['AIWG_HOUSEKEEPER_SYSTEMD_DIR'];
  savedLaunchdDir = process.env['AIWG_HOUSEKEEPER_LAUNCHD_DIR'];
  process.env['AIWG_HOUSEKEEPER_SYSTEMD_DIR'] = systemdDir;
  process.env['AIWG_HOUSEKEEPER_LAUNCHD_DIR'] = launchdDir;
});

afterEach(() => {
  if (savedSystemdDir === undefined) delete process.env['AIWG_HOUSEKEEPER_SYSTEMD_DIR'];
  else process.env['AIWG_HOUSEKEEPER_SYSTEMD_DIR'] = savedSystemdDir;
  if (savedLaunchdDir === undefined) delete process.env['AIWG_HOUSEKEEPER_LAUNCHD_DIR'];
  else process.env['AIWG_HOUSEKEEPER_LAUNCHD_DIR'] = savedLaunchdDir;
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(systemdDir, { recursive: true, force: true });
  fs.rmSync(launchdDir, { recursive: true, force: true });
});

function writeConfig(config: unknown): void {
  fs.mkdirSync(path.join(cwd, '.aiwg'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.aiwg', 'daemon.json'), JSON.stringify(config, null, 2));
}

describe('housekeeperHandler metadata', () => {
  it('registers under the daemon category with matching help', async () => {
    expect(housekeeperHandler.id).toBe('housekeeper');
    expect(housekeeperHandler.category).toBe('daemon');
    expect(housekeeperHandlers).toEqual([housekeeperHandler]);
    const help = await housekeeperHandler.help!({ ...makeCtx([]), args: [] });
    expect(help.exitCode).toBe(0);
    for (const verb of ['start', 'stop', 'status', 'run-once']) {
      expect(help.message).toContain(verb);
    }
    expect(housekeeperHelpText()).toContain('Windows is not supported');
  });

  it('rejects missing and unknown subcommands with exit 2', async () => {
    expect((await housekeeperHandler.execute(makeCtx([]))).exitCode).toBe(2);
    const unknown = await housekeeperHandler.execute(makeCtx(['frobnicate']));
    expect(unknown.exitCode).toBe(2);
    expect(unknown.message).toContain('unknown subcommand');
  });

  it('rejects unknown flags with exit 2', async () => {
    const result = await housekeeperHandler.execute(makeCtx(['status', '--bogus']));
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('--bogus');
  });
});

describe('run-once', () => {
  beforeEach(() => {
    writeConfig({
      daemon: { profile: 'housekeeper' },
      schedule: { enabled: true, jobs: [{ id: 'nightly', kind: 'cache.prune', cron: '0 2 * * *' }] },
    });
  });

  it('fails headless naming --job when the flag is absent', async () => {
    const result = await housekeeperHandler.execute(makeCtx(['run-once', '--non-interactive']));
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('--job');
  });

  it('fails when --job has no value', async () => {
    const result = await housekeeperHandler.execute(makeCtx(['run-once', '--job']));
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('--job');
  });

  it('rejects unknown job ids', async () => {
    const result = await housekeeperHandler.execute(makeCtx(['run-once', '--job', 'nope', '--non-interactive']));
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('unknown job');
  });

  it('dry-run prints without spawning', async () => {
    const result = await housekeeperHandler.execute(makeCtx(['run-once', '--job', 'nightly', '--dry-run']));
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('nightly');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('reuses the B2 manual path through the script runner', async () => {
    const result = await housekeeperHandler.execute(makeCtx(['run-once', '--job', 'nightly', '--json']));
    expect(result.exitCode).toBe(0);
    expect(mockRun).toHaveBeenCalledWith(
      'tools/daemon/index.mjs',
      ['schedule', '--run-once', '--job', 'nightly', '--json'],
    );
  });
});

describe('job management', () => {
  it('fails headless naming --id when required values are missing', async () => {
    const result = await housekeeperHandler.execute(makeCtx(['job', 'register', '--non-interactive']));
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('--id');
  });

  it('registers, lists, and disables a job round-trip', async () => {
    const registered = await housekeeperHandler.execute(makeCtx([
      'job', 'register', '--id', 'nightly', '--kind', 'cache.prune', '--schedule', '0 2 * * *',
      '--retries', '1', '--non-interactive',
    ]));
    expect(registered.exitCode).toBe(0);

    const listed = await housekeeperHandler.execute(makeCtx(['job', 'list']));
    expect(listed.exitCode).toBe(0);
    expect(listed.message).toContain('nightly');

    const listedJson = await housekeeperHandler.execute(makeCtx(['job', 'list', '--json']));
    expect(listedJson.exitCode).toBe(0);
    expect(JSON.parse(listedJson.message!).jobs).toHaveLength(1);

    const disabled = await housekeeperHandler.execute(makeCtx(['job', 'disable', '--id', 'nightly', '--non-interactive']));
    expect(disabled.exitCode).toBe(0);
    expect(JSON.parse((await housekeeperHandler.execute(makeCtx(['job', 'list', '--json']))).message!).jobs).toHaveLength(0);
  });

  it('rejects unknown kinds, bad cron, and bad retries', async () => {
    const base = ['job', 'register', '--id', 'x', '--non-interactive'];
    expect((await housekeeperHandler.execute(makeCtx([...base, '--kind', 'nope', '--schedule', '0 2 * * *']))).exitCode).toBe(2);
    expect((await housekeeperHandler.execute(makeCtx([...base, '--kind', 'cache.prune', '--schedule', 'hourly']))).exitCode).toBe(2);
    expect((await housekeeperHandler.execute(makeCtx([...base, '--kind', 'cache.prune', '--schedule', '0 2 * * *', '--retries', '5']))).exitCode).toBe(2);
  });

  it('disable rejects unknown ids', async () => {
    writeConfig({ daemon: { profile: 'housekeeper' }, schedule: { enabled: true, jobs: [] } });
    const result = await housekeeperHandler.execute(makeCtx(['job', 'disable', '--id', 'ghost', '--non-interactive']));
    expect(result.exitCode).toBe(2);
  });
});

describe('watch management', () => {
  it('registers, lists, and disables a watch root round-trip', async () => {
    const registered = await housekeeperHandler.execute(makeCtx([
      'watch', 'register', '--path', 'src/', '--events', 'create,modify', '--non-interactive',
    ]));
    expect(registered.exitCode).toBe(0);
    expect(registered.message).toContain('cron remains the scheduling authority');

    const listed = await housekeeperHandler.execute(makeCtx(['watch', 'list']));
    expect(listed.message).toContain('src/');

    const disabled = await housekeeperHandler.execute(makeCtx(['watch', 'disable', '--path', 'src/', '--non-interactive']));
    expect(disabled.exitCode).toBe(0);
    expect((await housekeeperHandler.execute(makeCtx(['watch', 'list']))).message).toContain('No watch roots');
  });

  it('fails headless naming --path when absent', async () => {
    const result = await housekeeperHandler.execute(makeCtx(['watch', 'register', '--non-interactive']));
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('--path');
  });
});

describe('status --json contract', () => {
  it('emits contractVersion/command/status/mode/jobs/totals plus freshness with no daemon', async () => {
    writeConfig({
      daemon: { profile: 'housekeeper' },
      schedule: { enabled: true, jobs: [{ id: 'nightly', kind: 'cache.prune', cron: '0 2 * * *' }] },
    });
    const result = await housekeeperHandler.execute(makeCtx(['status', '--json', '--non-interactive']));
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.message!);
    expect(envelope.contractVersion).toBe(1);
    expect(envelope.command).toBe('housekeeper.status');
    expect(envelope.status).toBe('ok');
    expect(envelope.mode).toBe('offline');
    expect(envelope.pid).toBeNull();
    expect(envelope.jobs).toHaveLength(1);
    expect(envelope.jobs[0]).toMatchObject({ id: 'nightly', kind: 'cache.prune', lastState: 'never' });
    expect(envelope.totals).toMatchObject({ jobs: 1, never: 1 });
    expect(Array.isArray(envelope.freshness)).toBe(true);
    for (const entry of envelope.freshness) {
      expect(entry).toHaveProperty('index');
      expect(entry).toHaveProperty('state');
      expect(entry).toHaveProperty('targetMs');
      expect(entry).toHaveProperty('converged');
    }
    expect(envelope.update.checkOnly).toBe(true);
  });

  it('reports stopped without a daemon', async () => {
    const result = await housekeeperHandler.execute(makeCtx(['status', '--non-interactive']));
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('stopped');
  });
});

describe('lifecycle guards', () => {
  it('blocks a second start while the pid file is live', async () => {
    fs.mkdirSync(path.join(cwd, '.aiwg'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.aiwg', 'daemon.pid'), String(process.pid));
    const result = await housekeeperHandler.execute(makeCtx(['start', '--non-interactive']));
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('already running');
  });

  it('refuses to flip a foreign profile headless without --force', async () => {
    writeConfig({ daemon: { profile: 'default' }, schedule: { enabled: false } });
    const result = await housekeeperHandler.execute(makeCtx(['start', '--foreground', '--non-interactive']));
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('--force');
    expect(JSON.parse(fs.readFileSync(path.join(cwd, '.aiwg', 'daemon.json'), 'utf8')).daemon.profile).toBe('default');
  });

  it('stop reports not-running with exit 0 and no daemon', async () => {
    const result = await housekeeperHandler.execute(makeCtx(['stop', '--non-interactive']));
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('not running');
  });
});

describe('install', () => {
  it('--dry-run prints units and writes nothing', async () => {
    const before = fs.readdirSync(systemdDir);
    const result = await housekeeperHandler.execute(
      makeCtx(['install', '--systemd-user', '--with-timer', '--dry-run', '--non-interactive']),
    );
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('aiwg-housekeeper.service');
    expect(result.message).toContain('aiwg-housekeeper.timer');
    expect(result.message).toContain('housekeeper run-once');
    expect(fs.readdirSync(systemdDir)).toEqual(before);
  });

  it('writes units without enabling, and uninstall removes them', async () => {
    const installed = await housekeeperHandler.execute(makeCtx(['install', '--systemd-user', '--non-interactive']));
    expect(installed.exitCode).toBe(0);
    expect(installed.message).toContain('NOT enabled');
    expect(fs.existsSync(path.join(systemdDir, 'aiwg-housekeeper.service'))).toBe(true);

    const uninstalled = await housekeeperHandler.execute(makeCtx(['uninstall', '--non-interactive']));
    expect(uninstalled.exitCode).toBe(0);
    expect(fs.existsSync(path.join(systemdDir, 'aiwg-housekeeper.service'))).toBe(false);
  });

  it('requires an explicit backend flag headless', async () => {
    const result = await housekeeperHandler.execute(makeCtx(['install', '--non-interactive']));
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('--systemd-user');
  });
});
