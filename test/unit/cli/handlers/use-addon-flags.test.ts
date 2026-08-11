import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  frameworkRoot: '',
  run: vi.fn(async () => ({ exitCode: 0, message: '' })),
  registerDeployedExtensions: vi.fn(),
  registerCliCommands: vi.fn(),
  registerHooks: vi.fn(),
}));

vi.mock('../../../../src/channel/manager.mjs', () => ({
  getFrameworkRoot: vi.fn(async () => state.frameworkRoot),
  getVersionInfo: vi.fn(async () => ({ version: 'test', channel: 'test' })),
}));

vi.mock('../../../../src/cli/handlers/script-runner.js', () => ({
  createScriptRunner: vi.fn(() => ({ run: state.run })),
}));

vi.mock('../../../../src/cli/project-isolation/index.js', () => ({
  maybeWarnProjectIsolation: vi.fn(async () => ({ cancelled: false })),
}));

vi.mock('../../../../src/extensions/deployment-registration.js', () => ({
  registerDeployedExtensions: state.registerDeployedExtensions,
}));

vi.mock('../../../../src/cli/cli-extension-loader.js', () => ({
  registerCliCommands: state.registerCliCommands,
  registerHooks: state.registerHooks,
}));

import { UseHandler } from '../../../../src/cli/handlers/use.js';

describe('UseHandler upstream addon and extension deploy flags', () => {
  let frameworkRoot: string;
  let target: string;

  beforeEach(async () => {
    frameworkRoot = await mkdtemp(path.join(os.tmpdir(), 'aiwg-use-addon-flags-root-'));
    target = await mkdtemp(path.join(os.tmpdir(), 'aiwg-use-addon-flags-target-'));
    state.frameworkRoot = frameworkRoot;
    state.run.mockClear();
    state.registerDeployedExtensions.mockClear();
    state.registerCliCommands.mockClear();
    state.registerHooks.mockClear();
  });

  afterEach(async () => {
    await rm(frameworkRoot, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });

  it.each([
    ['addon', 'addons'],
    ['extension', 'extensions'],
  ] as const)('forwards dry-run, verbose, and force for an upstream %s', async (_kind, sourceGroup) => {
    const id = `test-${_kind}`;
    const source = path.join(frameworkRoot, 'agentic', 'code', sourceGroup, id);
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'manifest.json'), JSON.stringify({
      id,
      type: 'addon',
      cli_commands: {
        namespace: id,
        entry: 'commands/',
        subcommands: {
          run: { file: 'run.mjs', hook_event: 'SessionStart' },
        },
      },
      memory: { topology: { namespace: `.aiwg/${id}` } },
      templates: ['generic.md', 'team.md'],
    }));

    const handler = new UseHandler();
    const result = await handler.execute({
      args: [
        id,
        '--provider', 'codex',
        '--target', target,
        '--dry-run',
        '--verbose',
        '--force',
      ],
      rawArgs: [],
      cwd: target,
      frameworkRoot,
    });

    expect(result.exitCode).toBe(0);
    expect(state.run).toHaveBeenCalledTimes(1);
    expect(state.run).toHaveBeenCalledWith(
      'tools/agents/deploy-agents.mjs',
      [
        '--source', source,
        '--deploy-commands',
        '--deploy-skills',
        '--deploy-rules',
        '--provider', 'codex',
        '--target', target,
        '--dry-run',
        '--verbose',
        '--force',
      ],
      {},
    );
    expect(state.registerDeployedExtensions).not.toHaveBeenCalled();
    expect(state.registerCliCommands).not.toHaveBeenCalled();
    expect(state.registerHooks).not.toHaveBeenCalled();
    expect(await readdir(target)).toEqual([]);
  });
});
