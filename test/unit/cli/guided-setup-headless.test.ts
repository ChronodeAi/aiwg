import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guidedInventory } from '../../helpers/guided-setup-fixture.js';
import { guidedHarness, withoutAnswerMetadata } from '../../helpers/guided-setup-harness.js';

vi.mock('../../../src/cli/env.js', () => ({ isInteractive: vi.fn() }));
vi.mock('../../../src/cli/prompt-utils.js', async importOriginal => ({ ...await importOriginal<object>(), askString: vi.fn(), createPromptInterface: vi.fn() }));
vi.mock('../../../src/discovery/index.js', async importOriginal => ({ ...await importOriginal<object>(), discoverInventory: vi.fn() }));
vi.mock('../../../src/config/aiwg-config.js', async importOriginal => ({ ...await importOriginal<object>(), readAiwgConfig: vi.fn(), writeAiwgConfig: vi.fn() }));
vi.mock('../../../src/process/bounded-child-process.mjs', () => ({ boundedSpawnSync: vi.fn() }));
import { isInteractive } from '../../../src/cli/env.js';
import { askString, createPromptInterface } from '../../../src/cli/prompt-utils.js';
import { discoverInventory } from '../../../src/discovery/index.js';
import { readAiwgConfig, writeAiwgConfig } from '../../../src/config/aiwg-config.js';
import { boundedSpawnSync } from '../../../src/process/bounded-child-process.mjs';
import { initHandler } from '../../../src/cli/handlers/init.js';
import { setupHandler } from '../../../src/cli/handlers/setup.js';
import { parseGuidedSetupFlags } from '../../../src/cli/handlers/guided-setup.js';
import { questionId, workspaceSlug } from '../../../src/discovery/interview.js';
import type { SetupPlan } from '../../../src/discovery/plan-types.js';
import { remainingPlanActions } from '../../../src/discovery/plan-store.js';
import { initCommand, setupCommand } from '../../../src/extensions/commands/definitions.js';

let harness: ReturnType<typeof guidedHarness>;
let inventory: ReturnType<typeof guidedInventory>;
function stored(): SetupPlan {
  return JSON.parse(readFileSync(join(harness.artifacts, 'setup', 'plans', `setup-${workspaceSlug(harness.project)}.json`), 'utf8'));
}
beforeEach(() => {
  harness = guidedHarness('aiwg-guided-headless-'); inventory = guidedInventory(harness.project);
  vi.mocked(isInteractive).mockReturnValue(false);
  vi.mocked(discoverInventory).mockImplementation(async () => structuredClone(inventory));
  vi.mocked(readAiwgConfig).mockResolvedValue(null);
  vi.mocked(boundedSpawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '' } as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => harness.cleanup());

describe('guided setup headless contract', () => {
  it.each(['--jev', '--region', '--endpoint', '--scope', '--intent', '--credential', '--workspace', '--monorepo', '--package', '--scan-roots'])('strictly rejects missing/empty %s, including later occurrences', async flag => {
    for (const tail of [[flag], [`${flag}=`], [flag, '--yes'], [flag, 'project', flag]]) {
      await expect(setupHandler.execute(harness.ctx(tail))).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining(flag) });
    }
    expect(discoverInventory).not.toHaveBeenCalled();
    expect(askString).not.toHaveBeenCalled();
  });

  it('maps Jev setup flags to references only and rejects malformed or conflicting options', () => {
    expect(parseGuidedSetupFlags(['--jev', 'enable', '--credential', 'jev=env:JEV_API_KEY', '--region', 'eu', '--verify'], 'setup')).toMatchObject({
      enabled: true, jev: 'enable', jevOptions: { region: 'eu', verify: true }, credentials: { jev: { source: 'env', name: 'JEV_API_KEY' } },
    });
    expect(parseGuidedSetupFlags(['--credential', 'codex=store:codex-main'], 'init')).toMatchObject({ credentials: { codex: { source: 'store', name: 'codex-main' } } });
    expect(parseGuidedSetupFlags(['--token-stdin'], 'init')).toMatchObject({ jev: 'enable', credentials: { jev: { source: 'stdin-at-apply' } } });
    expect(parseGuidedSetupFlags(['--remove'], 'setup')).toMatchObject({ jev: 'decline', jevOptions: { remove: true } });
    expect(() => parseGuidedSetupFlags(['--jev'], 'setup')).toThrow(/--jev/);
    expect(() => parseGuidedSetupFlags(['--region'], 'setup')).toThrow(/--region/);
    expect(() => parseGuidedSetupFlags(['--jev', 'decline', '--verify'], 'setup')).toThrow();
    expect(() => parseGuidedSetupFlags(['--jev', 'enable', '--remove'], 'setup')).toThrow();
    expect(() => parseGuidedSetupFlags(['--endpoint', 'https://user:secret@example.test'], 'setup')).toThrow();
    expect(() => parseGuidedSetupFlags(['--credential', 'jev=pasted-secret'], 'setup')).toThrow();
  });

  it('parses repeatable locators and roots, equals syntax and the -- terminator', () => {
    const flags = parseGuidedSetupFlags(['--workspace=/a', '--workspace', '/b', '--scan-roots', '/c', '--credential', 'codex=env:OPENAI_API_KEY', '--credential', 'claude=stdin', '--intent=docs'], 'setup');
    expect(flags).toMatchObject({ enabled: true, workspaces: ['/a', '/b'], scanRoots: ['/c'], intent: 'docs',
      credentials: { codex: { kind: 'credential-ref', source: 'env', name: 'OPENAI_API_KEY' }, claude: { source: 'stdin-at-apply' } } });
    expect(parseGuidedSetupFlags(['--', '--scope'], 'setup').enabled).toBe(false);
    expect(() => parseGuidedSetupFlags(['--monorepo', 'package'], 'setup')).toThrow(/--package/);
    expect(() => parseGuidedSetupFlags(['--jev', 'decline', '--scope', 'other'], 'init')).toThrow(/--scope/);
    expect(() => parseGuidedSetupFlags(['--intent', 'other'], 'init')).toThrow(/--intent/);
  });

  it('writes only a plan, never prompts, and preserves declined/skipped optionals', async () => {
    const result = await initHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'project', '--intent', 'docs', '--providers', 'codex', '--default-scripts', 'false', '--worker-dispatch', 'decline', '--credential', 'codex=env:OPENAI_API_KEY', '--yes']));
    expect(result.exitCode).toBe(0);
    const plan = stored();
    expect(plan.answers[questionId('tools', 'scripts', harness.project)].value).toMatchObject({ defaultScripts: false });
    expect(plan.answers[questionId('tools', 'worker-dispatch', harness.project)].value).toBe('decline');
    expect(plan.actions.filter(a => a.kind === 'deploy-framework')).toHaveLength(1);
    expect(remainingPlanActions(plan)).toEqual(plan.actions);
    expect(plan).not.toHaveProperty('config');
    expect(existsSync(join(harness.project, '.aiwg'))).toBe(false);
    expect(writeAiwgConfig).not.toHaveBeenCalled();
    expect(createPromptInterface).not.toHaveBeenCalled();
    expect(askString).not.toHaveBeenCalled();
    expect(isInteractive).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('produces byte-identical plans to confirmed TTY answers after removing answer metadata', async () => {
    const flags = ['--jev', 'decline', '--scope', 'project', '--intent', 'docs', '--providers', 'codex', '--default-scripts', 'false', '--worker-dispatch', 'decline', '--credential', 'codex=env:OPENAI_API_KEY'];
    await initHandler.execute(harness.ctx([...flags, '--yes']));
    const headless = stored();
    rmSync(join(harness.artifacts, 'setup'), { recursive: true });
    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(createPromptInterface).mockReturnValue({ close: vi.fn() } as never);
    const script = [harness.project, 'skip', 'docs', 'solo', 'false', 'true', 'false', '', 'env:OPENAI_API_KEY', 'decline', 'skip', 'skip', 'skip'];
    vi.mocked(askString).mockImplementation(async () => {
      const value = script.shift();
      if (value === undefined) throw new Error('Unexpected prompt');
      return value;
    });
    await initHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'project']));
    expect(script).toEqual([]);
    expect(withoutAnswerMetadata(stored())).toBe(withoutAnswerMetadata(headless));
  });

  it('requires explicit monorepo selection with a message naming --monorepo', async () => {
    inventory.projects[0].layout = 'monorepo'; inventory.projects[0].packageRoots = [join(harness.project, 'packages', 'app')];
    await expect(setupHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'project', '--yes']))).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('--monorepo root|package') });
    expect(askString).not.toHaveBeenCalled();
    await setupHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'project', '--monorepo', 'root', '--yes']));
    expect(stored().answers[questionId('targets', 'root', harness.project)].value).toBe('root');
  });

  it('requires --issue-provider for an unknown remote, never asks or writes config', async () => {
    vi.mocked(boundedSpawnSync).mockReturnValue({ status: 0, stdout: 'origin ssh://git@example.test/repo.git (fetch)\n', stderr: '' } as never);
    await expect(setupHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'project', '--yes']))).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('--issue-provider') });
    await expect(setupHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'project', '--yes', '--primary', 'origin']))).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('--issue-provider') });
    await setupHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'project', '--yes', '--issue-provider', 'local']));
    expect(stored().answers[questionId('capabilities', 'tracker', harness.project)].value).toEqual({ issue_provider: 'local' });
    expect(askString).not.toHaveBeenCalled();
    expect(writeAiwgConfig).not.toHaveBeenCalled();
  });

  it('asks for an unknown remote provider interactively while retaining a supplied remote name', async () => {
    vi.mocked(boundedSpawnSync).mockReturnValue({ status: 0, stdout: 'origin ssh://git@example.test/repo.git (fetch)\n', stderr: '' } as never);
    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(createPromptInterface).mockReturnValue({ close: vi.fn() } as never);
    vi.mocked(askString).mockImplementation(async () => {
      const lastQuestion = vi.mocked(console.log).mock.calls.filter(([line]) => typeof line === 'string' && line.startsWith('capabilities.tracker.')).at(-1);
      return lastQuestion ? 'gitea' : 'skip';
    });
    await setupHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'project', '--primary', 'origin']));
    expect(stored().answers[questionId('capabilities', 'tracker', harness.project)].value).toEqual({ primary: 'origin', issue_provider: 'gitea' });
  });

  it('advertises the new flags in command definitions and handler help', async () => {
    const initHelp = (await initHandler.help!(harness.ctx([]))).message!;
    const setupHelp = (await setupHandler.help!(harness.ctx([]))).message!;
    for (const flag of ['--jev', 'decline', '--scope', '--intent', '--credential']) {
      expect(initHelp).toContain(flag);
      expect(JSON.stringify(initCommand.metadata)).toContain(flag);
    }
    for (const flag of ['--jev', 'decline', '--scope', '--intent', '--credential', '--workspace', '--monorepo', '--package', '--scan-roots']) {
      expect(setupHelp).toContain(flag);
      expect(JSON.stringify(setupCommand.metadata)).toContain(flag);
    }
  });

  it('maps setup policy flags without activating false capabilities', async () => {
    await setupHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'user', '--yes', '--providers', 'codex', '--require-signed-commits', 'false', '--delivery-mode', 'pr-required', '--force-push-policy', 'never', '--primary', 'origin', '--issue-provider', 'local']));
    const plan = stored();
    expect(plan.answers[questionId('capabilities', 'signing', harness.project)].value).toBe(false);
    expect(plan.answers[questionId('capabilities', 'delivery', harness.project)].value).toEqual({ mode: 'pr-required', force_push_policy: 'never' });
    expect(plan.answers[questionId('intent', 'team', harness.project)].value).toBe('shared');
    expect(plan.actions.every(a => a.scope === 'user')).toBe(true);
    expect(plan.actions.some(a => a.kind.includes('signing'))).toBe(false);
  });

  it('honors dry-run without writing a plan', async () => {
    await initHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'project', '--yes', '--dry-run']));
    expect(existsSync(join(harness.artifacts, 'setup'))).toBe(false);
    expect(writeAiwgConfig).not.toHaveBeenCalled();
  });

  it('selects an observed package and records facts for the actual target paths', async () => {
    const packageRoot = join(harness.project, 'packages', 'app');
    inventory.projects[0].layout = 'monorepo'; inventory.projects[0].packageRoots = [packageRoot];
    await setupHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'project', '--yes', '--monorepo', 'package', '--package', packageRoot, '--providers', 'codex']));
    const plan = stored();
    expect(plan.actions.every(action => action.workspace === packageRoot)).toBe(true);
    expect(plan.actions.find(action => action.kind === 'configure-provider')?.dependsOn).toContainEqual({ kind: 'path', workspace: packageRoot, path: join(packageRoot, 'AGENTS.md') });
    expect(plan.actions.find(action => action.kind === 'write-project-config')?.dependsOn).toContainEqual({ kind: 'path', workspace: packageRoot, path: join(packageRoot, '.aiwg', 'aiwg.config') });
    await expect(setupHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'project', '--yes', '--monorepo', 'package', '--package', '/unobserved']))).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('--package') });
  });

  it('applies repeatable workspace/scan flags and preserves each workspace\'s existing settings', async () => {
    const other = join(harness.scratch, 'other');
    inventory.projects.push({ ...guidedInventory(other).projects[0], sources: ['registry'] });
    vi.mocked(readAiwgConfig).mockImplementation(async root => ({ version: '1', providers: [root === other ? 'codex' : 'claude'], scripts: {}, installed: {} }));
    await setupHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'project', '--yes', '--workspace', harness.project, '--workspace', other, '--scan-roots', harness.scratch]));
    expect(discoverInventory).toHaveBeenCalledWith({ workspaceRoot: harness.project, roots: [harness.scratch] });
    const plan = stored();
    expect(plan.answers[questionId('tools', 'provider', harness.project, 'claude')]).toMatchObject({ value: true, source: 'existing-setting' });
    expect(plan.answers[questionId('tools', 'provider', other, 'codex')]).toMatchObject({ value: true, source: 'existing-setting' });
    expect(plan.answers[questionId('tools', 'provider', other, 'claude')].value).toBe(false);
    expect(plan.actions.some(action => action.workspace === other && action.provider === 'codex')).toBe(true);
    expect(askString).not.toHaveBeenCalled();
  });
});
