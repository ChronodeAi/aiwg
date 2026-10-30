import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';

const { spawnSync, readAiwgConfig } = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  readAiwgConfig: vi.fn(),
}));

vi.mock('child_process', () => ({ spawnSync }));
vi.mock('../../../../src/channel/manager.mjs', () => ({
  getVersionInfo: async () => ({ version: 'test', channel: 'test', packageRoot: '/synthetic/package' }),
}));
vi.mock('../../../../src/config/aiwg-config.js', () => ({
  getProjectDir: (ctx: HandlerContext) => ctx.cwd,
  readAiwgConfig,
}));
vi.mock('../../../../src/cli/log.js', () => ({
  getLoggerInfo: () => ({ level: 'off', logFile: null, disabled: true, provenance: { os_release: 'test', invocation_id: 'test' } }),
  getLogger: () => ({ span: () => ({ end: vi.fn() }) }),
}));

import { diagnoseHandler } from '../../../../src/cli/handlers/diagnose.js';

const secret = 'synthetic-diagnose-secret';
let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-diagnose-test-'));
  vi.stubEnv('AIWG_DIAGNOSE_TEST_TOKEN', secret);
  spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });
  readAiwgConfig.mockResolvedValue({ token: secret });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(cwd, { recursive: true, force: true });
});

function context(args: string[]): HandlerContext {
  return { cwd, args, rawArgs: ['diagnose', ...args], frameworkRoot: cwd };
}

describe('diagnose secret opt-in', () => {
  it('keeps legacy stdout sanitized without an opt-in warning', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await diagnoseHandler.execute(context(['--stdout']))).toEqual({ exitCode: 0 });
    const bundle = JSON.parse(String(output.mock.calls[0]![0]));
    expect(bundle.manifest.sanitized).toBe(true);
    expect(bundle.config.token).toBe('<redacted>');
    expect(JSON.stringify(output.mock.calls)).not.toContain(secret);
    expect(stderr).not.toHaveBeenCalled();
    expect(JSON.stringify(spawnSync.mock.calls.map(call => call.slice(0, 2)))).not.toContain(secret);
  });

  it('warns on stderr before explicitly printing secrets to stdout', async () => {
    const events: string[] = [];
    const output = vi.spyOn(console, 'log').mockImplementation(() => { events.push('stdout'); });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => { events.push('stderr'); return true; });
    expect(await diagnoseHandler.execute(context(['--stdout', '--include-secrets']))).toEqual({ exitCode: 0 });
    const bundle = JSON.parse(String(output.mock.calls[0]![0]));
    expect(bundle.manifest.sanitized).toBe(false);
    expect(bundle.config.token).toBe(secret);
    expect(events).toEqual(['stderr', 'stdout']);
    const warning = stderr.mock.calls.map(call => String(call[0])).join('');
    expect(warning).toContain('output contains secrets');
    expect(warning).toContain('Review it before sharing');
    expect(warning).not.toContain(secret);
    expect(JSON.stringify(spawnSync.mock.calls.map(call => call.slice(0, 2)))).not.toContain(secret);
  });

  it('explains the exposure in command help without collecting a bundle', async () => {
    const result = await diagnoseHandler.help!(context(['--help']));
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('--include-secrets');
    expect(result.message).toContain('Output contains secrets; review it before sharing');
    expect(spawnSync).not.toHaveBeenCalled();
    expect(readAiwgConfig).not.toHaveBeenCalled();
  });
});
