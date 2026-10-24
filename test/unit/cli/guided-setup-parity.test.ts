import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guidedInventory, INTERVIEW_TIME } from '../../helpers/guided-setup-fixture.js';
import { guidedHarness, withoutAnswerMetadata } from '../../helpers/guided-setup-harness.js';

vi.mock('../../../src/cli/env.js', () => ({ isInteractive: vi.fn() }));
vi.mock('../../../src/cli/prompt-utils.js', async importOriginal => ({ ...await importOriginal<object>(), askString: vi.fn(), createPromptInterface: vi.fn() }));
vi.mock('../../../src/discovery/index.js', async importOriginal => ({ ...await importOriginal<object>(), discoverInventory: vi.fn() }));
vi.mock('../../../src/config/aiwg-config.js', async importOriginal => ({ ...await importOriginal<object>(), readAiwgConfig: vi.fn() }));
vi.mock('../../../src/process/bounded-child-process.mjs', () => ({ boundedSpawnSync: vi.fn() }));
import { isInteractive } from '../../../src/cli/env.js';
import { askString, createPromptInterface } from '../../../src/cli/prompt-utils.js';
import { discoverInventory } from '../../../src/discovery/index.js';
import { emptyConfig, readAiwgConfig } from '../../../src/config/aiwg-config.js';
import { boundedSpawnSync } from '../../../src/process/bounded-child-process.mjs';
import { setupHandler } from '../../../src/cli/handlers/setup.js';
import { workspaceSlug } from '../../../src/discovery/interview.js';
import { applyGuidedPlan, reviewGuidedPlan, type PlanApplyIO } from '../../../src/discovery/plan-apply.js';
import type { SetupPlan } from '../../../src/discovery/plan-types.js';

let harness: ReturnType<typeof guidedHarness>;
let inventory: ReturnType<typeof guidedInventory>;
function planPath(): string { return join(harness.artifacts, 'setup', 'plans', `setup-${workspaceSlug(harness.project)}.json`); }
function stored(): SetupPlan { return JSON.parse(readFileSync(planPath(), 'utf8')); }
function currentQuestion(): string {
  return vi.mocked(console.log).mock.calls.flatMap(([line]) => typeof line === 'string' && /^(targets|intent|tools|locations|capabilities)\./.test(line) ? [line.split(': ')[0]] : []).at(-1)!;
}
function applyIO(): PlanApplyIO {
  const owner = async ({ action }: { action: SetupPlan['actions'][number] }) => `${action.kind} ${action.scope} ${action.workspace}`;
  return { exists: async () => false, installMode: async () => ({ devMode: false, method: 'test', root: '' }),
    readEnv: () => 'synthetic-value', readCredentialFile: async () => { throw new Error('Credential files must never be read'); },
    now: () => INTERVIEW_TIME, save: async () => {},
    owners: { configureProvider: owner, verifyProvider: owner, writeProjectConfig: owner,
      deployFramework: owner, registerProject: owner, recordDecline: owner, configureWorkerDispatch: async () => {} },
  };
}
beforeEach(() => {
  harness = guidedHarness('aiwg-guided-parity-'); inventory = guidedInventory(harness.project);
  inventory.tools = ['codex', 'claude'].map(executable => ({ ...inventory.tools[0], executable, path: `/example/bin/${executable}` }));
  vi.mocked(isInteractive).mockReturnValue(false);
  vi.mocked(discoverInventory).mockImplementation(async () => structuredClone(inventory));
  vi.mocked(readAiwgConfig).mockResolvedValue(null);
  vi.mocked(boundedSpawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '' } as never);
  vi.mocked(createPromptInterface).mockReturnValue({ close: vi.fn() } as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => harness.cleanup());

const rows = [false, true].flatMap(existing => [0, 1, 2].flatMap(workers => ['project', 'user'].map(scope => ({
  name: `${existing ? 'existing' : 'fresh'} / ${workers} workers / ${scope} scope`, existing, workers, scope, monorepo: undefined as string | undefined,
})))).concat([false, true].flatMap(existing => ['root', 'package'].map(monorepo => ({
  name: `${existing ? 'existing' : 'fresh'} / monorepo ${monorepo}`, existing, workers: 2, scope: 'project', monorepo,
}))));

describe('guided setup interactive/headless parity matrix', () => {
  it.each(rows)('$name produces the same plan, review, owner calls and apply result', async ({ existing, workers, scope, monorepo }) => {
    inventory.tools.forEach((tool, index) => { tool.installed = index < workers ? 'yes' : 'no'; });
    const packageRoot = join(harness.project, 'packages', 'app');
    if (monorepo) {
      inventory.projects[0].layout = 'monorepo'; inventory.projects[0].packageRoots = [packageRoot];
      inventory.projects.push({ ...guidedInventory(packageRoot).projects[0], sources: ['selected'] });
    }
    if (existing) {
      const config = emptyConfig(['codex']);
      vi.mocked(readAiwgConfig).mockResolvedValue(config);
      // Both scopes already have provider files; the explicit scope is carried to every owner.
      inventory.projects[0].providerFiles = [
        { provider: 'codex', kind: 'config', path: join(harness.project, 'AGENTS.md') },
        { provider: 'codex', kind: 'config', path: join(harness.scratch, 'home', '.codex', 'config.toml') },
      ];
      inventory.projects[0].aiwg = { directory: true, configFile: join(harness.project, '.aiwg', 'aiwg.config'), contextFile: null };
    }
    const dispatch = workers > 1 ? 'enable' : 'decline';
    const headlessFlags = ['--scope', scope, '--workspace', harness.project, '--intent', 'docs', '--providers', 'codex',
      '--default-scripts', 'false', '--custom-scripts', String(existing), '--credential', 'codex=env:OPENAI_API_KEY', '--worker-dispatch', dispatch,
      '--jev', 'decline', ...(monorepo ? ['--monorepo', monorepo, ...(monorepo === 'package' ? ['--package', packageRoot] : [])] : []), '--yes'];
    await setupHandler.execute(harness.ctx(headlessFlags));
    const headless = stored();
    expect(askString).not.toHaveBeenCalled();
    expect(createPromptInterface).not.toHaveBeenCalled();
    rmSync(join(harness.artifacts, 'setup'), { recursive: true });
    vi.mocked(isInteractive).mockReturnValue(true);
    const prompted: string[] = [];
    vi.mocked(askString).mockImplementation(async () => {
      const id = currentQuestion(); prompted.push(id);
      if (id.startsWith('targets.scope.')) return scope;
      if (id.startsWith('targets.workspaces.')) return harness.project;
      if (id.startsWith('targets.root.')) return monorepo === 'package' ? packageRoot : 'root';
      if (id.startsWith('intent.use.')) return 'docs';
      if (id.startsWith('intent.team.')) return 'solo';
      if (id.startsWith('tools.provider.')) return String(id.endsWith('.codex'));
      if (id.startsWith('tools.scripts.')) return 'false';
      if (id.startsWith('locations.config-dir.')) return '';
      if (id.startsWith('locations.credential-source.')) return 'env:OPENAI_API_KEY';
      if (id.startsWith('tools.worker-dispatch.')) return dispatch;
      return 'skip';
    });
    // Supplying dispatch remains possible with fewer than two detected workers, when no offer is shown.
    await setupHandler.execute(harness.ctx(['--jev', 'decline', ...(workers < 2 ? ['--worker-dispatch', dispatch] : [])]));
    const interactive = stored();
    expect(prompted).toContain('targets.scope.shared');
    expect(JSON.parse(withoutAnswerMetadata(interactive))).toEqual(JSON.parse(withoutAnswerMetadata(headless)));
    expect(interactive.actions.every(action => action.scope === scope)).toBe(true);
    const target = monorepo === 'package' ? packageRoot : harness.project;
    expect(interactive.actions.every(action => action.workspace === target)).toBe(true);
    expect(await reviewGuidedPlan(interactive, inventory, applyIO(), INTERVIEW_TIME))
      .toEqual(await reviewGuidedPlan(headless, inventory, applyIO(), INTERVIEW_TIME));
    const interactiveIO = applyIO(); const headlessIO = applyIO();
    const interactiveOwner = vi.spyOn(interactiveIO.owners, 'configureProvider');
    const headlessOwner = vi.spyOn(headlessIO.owners, 'configureProvider');
    const fromInteractive = await applyGuidedPlan(interactive, inventory, interactiveIO);
    const fromFlags = await applyGuidedPlan(headless, inventory, headlessIO);
    expect(fromInteractive.result).toEqual(fromFlags.result);
    expect(interactiveOwner.mock.calls).toEqual(headlessOwner.mock.calls);
    expect(JSON.parse(withoutAnswerMetadata(fromInteractive.plan))).toEqual(JSON.parse(withoutAnswerMetadata(fromFlags.plan)));
    expect(fromFlags.result.classification).toBe(workers === 0 ? 'failure' : 'success');
  });

  it.each(['project', 'user'])('%s cancellation retains the exact last saved block; the same headless answers never prompt', async scope => {
    let saved = '';
    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(askString).mockImplementation(async () => {
      const id = currentQuestion();
      if (id.startsWith('targets.workspaces.')) return harness.project;
      if (id.startsWith('targets.scan-opt-in.')) return 'skip';
      if (id.startsWith('intent.use.')) { saved = readFileSync(planPath(), 'utf8'); return 'docs'; }
      return 'cancel';
    });
    const cancelled = await setupHandler.execute(harness.ctx(['--scope', scope, '--jev', 'decline']));
    expect(cancelled.message).toContain('cancelled');
    expect(saved).not.toBe(''); expect(readFileSync(planPath(), 'utf8')).toBe(saved);
    vi.mocked(askString).mockClear(); vi.mocked(createPromptInterface).mockClear();
    vi.mocked(isInteractive).mockReturnValue(false);
    await setupHandler.execute(harness.ctx(['--scope', scope, '--jev', 'decline', '--workspace', harness.project, '--yes']));
    expect(askString).not.toHaveBeenCalled(); expect(createPromptInterface).not.toHaveBeenCalled();
  });
});
