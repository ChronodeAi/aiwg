import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceStatus } from '../../../tools/cli/workspace-status.mjs';
import { statusHandler } from '../../../src/cli/handlers/workspace.js';
import { readNativeSandboxWarnings } from '../../../src/config/native-sandbox-warnings.js';

let root: string;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('status native-sandbox isolation advisory', () => {
  it('names the repository config when present and the compatibility source when it is the only config', async () => {
    root = await mkdtemp(join(tmpdir(), 'aiwg-native-source-'));
    const local = join(root, '.aiwg');
    const external = join(root, 'external');
    await mkdir(local);
    await mkdir(external);
    vi.stubEnv('AIWG_ARTIFACTS_PATH', external);
    const config = { parallelism: { worker_dispatch: false, groups: { workers: { maxParallel: 1,
      execution: { sandbox: 'workspace-write', approval: 'never', launchMode: 'native-sandbox' },
      members: [{ id: 'worker', cli: 'codex', model: 'synthetic-model', roles: ['coding'] }] } } } };
    await writeFile(join(external, 'aiwg.config'), JSON.stringify(config));
    expect((await readNativeSandboxWarnings(root))[0].configPath).toBe(join(external, 'aiwg.config'));
    await writeFile(join(local, 'aiwg.config'), JSON.stringify(config));
    expect((await readNativeSandboxWarnings(root))[0].configPath).toBe(join(local, 'aiwg.config'));
    await writeFile(join(local, 'aiwg.config'), '{}');
    expect(await readNativeSandboxWarnings(root)).toEqual([]);
  });

  it.each([undefined, 'systemd-unit', 'native-sandbox'])(
    'reports only native-sandbox groups in human and JSON status (%s)', async launchMode => {
      root = await mkdtemp(join(tmpdir(), 'aiwg-native-status-'));
      await mkdir(join(root, '.aiwg'));
      const configPath = join(root, '.aiwg', 'aiwg.config');
      const group = (mode?: string) => ({ maxParallel: 1,
        execution: { sandbox: 'workspace-write', approval: 'never', ...(mode ? { launchMode: mode } : {}) },
        members: [{ id: 'worker', cli: 'codex', model: 'synthetic-model', roles: ['coding'] }] });
      await writeFile(configPath, JSON.stringify({ parallelism: { worker_dispatch: false,
        groups: { workers: group(launchMode), harnesses: group(launchMode), isolated: group('systemd-unit') } } }));
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      for (const flags of [[], ['--json'], ['--probe', '--json']]) {
        log.mockClear();
        await workspaceStatus([root, ...flags]);
        const output = log.mock.calls.map(([line]) => String(line)).join('\n');
        if (flags.includes('--json')) {
          const payload = JSON.parse(output);
          expect(payload.nativeSandboxWarnings.map((warning: { group: string }) => warning.group))
            .toEqual(launchMode === 'native-sandbox' ? ['workers', 'harnesses'] : []);
          for (const warning of payload.nativeSandboxWarnings) expect(warning.configPath).toBe(configPath);
        }
        if (launchMode === 'native-sandbox') {
          expect(output).toContain('workers');
          expect(output).toContain('harnesses');
          expect(output).toContain(configPath);
          expect(output).toContain('systemd-unit isolation and its memory limit do not apply');
          expect(output).toContain("only the worker CLI's own sandbox applies");
        } else expect(output).not.toContain('systemd-unit isolation and its memory limit do not apply');
      }
      const result = await statusHandler.execute({ args: [root, '--probe', '--json'],
        rawArgs: ['status', root, '--probe', '--json'], cwd: root, frameworkRoot: process.cwd() });
      const payload = JSON.parse(result.message!);
      expect(payload.nativeSandboxWarnings.map((warning: { group: string }) => warning.group))
        .toEqual(launchMode === 'native-sandbox' ? ['workers', 'harnesses'] : []);
    });
});
