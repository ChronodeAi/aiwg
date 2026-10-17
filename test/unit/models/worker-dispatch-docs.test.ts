import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAiwgConfig } from '../../../src/config/aiwg-config.js';
import { ConfigLoader } from '../../../src/models/config-loader.js';
import { modelsHandler } from '../../../src/cli/handlers/models.js';

const frameworkRoot = path.resolve(import.meta.dirname, '../../..');
let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('worker dispatch getting-started example (#3172)', () => {
  it('loads the documented files and reaches qualification for all three roles', async () => {
    const doc = await readFile(path.join(frameworkRoot, 'docs/getting-started/worker-dispatch.md'), 'utf8');
    const section = doc.split('## Configure a worker group')[1].split('## Supported CLI versions')[0];
    const examples = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
    expect(examples).toHaveLength(2);
    const [config, models] = examples;
    root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-worker-docs-'));
    const cwd = path.join(root, 'project');
    const configDir = path.join(root, 'host-config');
    await mkdir(path.join(cwd, '.aiwg'), { recursive: true });
    await mkdir(configDir, { mode: 0o700 });
    vi.stubEnv('AIWG_CONFIG', configDir);
    vi.stubEnv('AIWG_HOME', frameworkRoot);
    await writeFile(path.join(cwd, '.aiwg/aiwg.config'), JSON.stringify(config));
    await writeFile(path.join(cwd, 'models.json'), JSON.stringify(models));
    const brief = path.join(cwd, 'brief.txt');
    await writeFile(brief, 'Inspect this project and report a bounded implementation plan.');

    const loadedConfig = await readAiwgConfig(cwd);
    const loadedModels = await new ConfigLoader(cwd).load(loadedConfig!.parallelism);
    expect(Object.keys(loadedConfig!.parallelism!.clis!)).toHaveLength(2);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const [role, task] of [['efficiency', 'inventory'], ['coding', 'implementation'], ['reasoning', 'review']]) {
      expect(loadedModels.defaults.workerSelection!.roleGuidance![role]).toEqual(
        models.defaults.workerSelection.roleGuidance[role]);
      const args = ['resolve', '--role', role, '--task', task, '--group', 'harness',
        '--brief', brief, '--workdir', cwd, '--final-output', path.join(cwd, 'result.json'), '--format', 'json'];
      expect((await modelsHandler.execute({ cwd, frameworkRoot, args, rawArgs: ['models', ...args] })).exitCode).toBe(2);
      const plan = JSON.parse(String(output.mock.calls.at(-1)![0]));
      expect(plan.status).toBe('blocked');
      expect(plan.diagnostics).toEqual([expect.objectContaining({ code: 'OG_ADAPTER_UNQUALIFIED' })]);
    }
  });
});
