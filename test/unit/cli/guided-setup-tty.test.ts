import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guidedInventory, INTERVIEW_TIME } from '../../helpers/guided-setup-fixture.js';
import { guidedHarness } from '../../helpers/guided-setup-harness.js';
vi.mock('../../../src/cli/env.js', () => ({ isInteractive: vi.fn() }));
vi.mock('../../../src/cli/prompt-utils.js', async importOriginal => ({ ...await importOriginal<object>(), askString: vi.fn(), createPromptInterface: vi.fn() }));
vi.mock('../../../src/discovery/index.js', async importOriginal => ({ ...await importOriginal<object>(), discoverInventory: vi.fn() }));
vi.mock('../../../src/config/aiwg-config.js', async importOriginal => ({ ...await importOriginal<object>(), readAiwgConfig: vi.fn(), writeAiwgConfig: vi.fn() }));
import { isInteractive } from '../../../src/cli/env.js';
import { askString, createPromptInterface } from '../../../src/cli/prompt-utils.js';
import { discoverInventory } from '../../../src/discovery/index.js';
import { emptyConfig, readAiwgConfig, writeAiwgConfig } from '../../../src/config/aiwg-config.js';
import { setupHandler } from '../../../src/cli/handlers/setup.js';
import { buildInterviewPlan } from '../../../src/discovery/interview.js';
import { initHandler } from '../../../src/cli/handlers/init.js';
import { questionId, workspaceSlug } from '../../../src/discovery/interview.js';
import { remainingPlanActions, unansweredPlanChoices } from '../../../src/discovery/plan-store.js';
import * as planStore from '../../../src/discovery/plan-store.js';
import type { SetupPlan } from '../../../src/discovery/plan-types.js';

let harness: ReturnType<typeof guidedHarness>;
let close: ReturnType<typeof vi.fn>;
function planPath(): string { return join(harness.artifacts, 'setup', 'plans', `setup-${workspaceSlug(harness.project)}.json`); }
function stored(): SetupPlan { return JSON.parse(readFileSync(planPath(), 'utf8')); }
function scripted(values: string[]): void {
  vi.mocked(askString).mockImplementation(async () => {
    const value = values.shift();
    if (value === undefined) throw new Error('Unexpected prompt');
    return value;
  });
}
function promptedIds(): string[] {
  return vi.mocked(console.log).mock.calls.flatMap(([line]) => typeof line === 'string' && /^(targets|intent|tools|locations|capabilities)\./.test(line) ? [line.split(': ')[0]] : []);
}
beforeEach(() => {
  harness = guidedHarness('aiwg-guided-tty-'); close = vi.fn();
  vi.mocked(isInteractive).mockReturnValue(true);
  vi.mocked(discoverInventory).mockResolvedValue(guidedInventory(harness.project));
  vi.mocked(readAiwgConfig).mockResolvedValue(null);
  vi.mocked(createPromptInterface).mockReturnValue({ close } as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => harness.cleanup());

describe('progressive guided setup TTY', () => {
  it('asks the exact block order and skips flag-supplied questions', async () => {
    const saves = vi.spyOn(planStore, 'writeSetupPlan');
    const script = [harness.project, 'skip', 'docs', 'solo', 'false', 'true', 'false', '', 'env:OPENAI_API_KEY', 'decline', 'false', 'false', 'skip'];
    scripted(script);
    await initHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'project']));
    const id = (block: Parameters<typeof questionId>[0], topic: string, provider = 'shared') => questionId(block, topic, harness.project, provider);
    expect(promptedIds()).toEqual([
      id('targets', 'workspaces'), questionId('targets', 'scan-opt-in'), id('intent', 'use'), id('intent', 'team'),
      id('tools', 'provider', 'claude'), id('tools', 'provider', 'codex'), id('tools', 'scripts'),
      id('locations', 'config-dir', 'codex'), id('locations', 'credential-source', 'codex'),
      id('tools', 'worker-dispatch'), id('capabilities', 'signing'), id('capabilities', 'delivery'), id('capabilities', 'tracker'),
    ]);
    expect(script).toEqual([]);
    const plan = stored();
    expect(plan.answers[id('tools', 'provider', 'claude')].value).toBe(false);
    expect(remainingPlanActions(plan)).toEqual(plan.actions);
    expect(plan).not.toHaveProperty('config');
    expect(plan.actions.some(a => a.kind.includes('signing') || a.kind.includes('tracker') || a.kind.includes('delivery'))).toBe(false);
    expect(existsSync(join(harness.project, '.aiwg'))).toBe(false);
    expect(writeAiwgConfig).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(isInteractive).toHaveBeenCalledExactlyOnceWith(false);
    expect(saves).toHaveBeenCalledTimes(5);
    expect(discoverInventory).toHaveBeenCalledExactlyOnceWith({ workspaceRoot: harness.project, roots: undefined });
  });

  it.each(['flag', 'interview'])('defers Jev via %s without a credential and asks it first next session', async mode => {
    const flags = ['--scope', 'project', '--providers', 'codex', '--worker-dispatch', 'decline', '--default-scripts', 'true'];
    const jevId = questionId('capabilities', 'jev', harness.project);
    vi.mocked(askString).mockImplementation(async () => promptedIds().at(-1) === jevId ? 'defer' : 'skip');
    await initHandler.execute(harness.ctx([...flags, ...(mode === 'flag' ? ['--jev', 'defer'] : [])]));
    expect(unansweredPlanChoices(stored()).find(q => q.questionId === jevId)?.deferredAt).toBe(INTERVIEW_TIME);
    expect(stored().actions.some(a => a.kind === 'configure-jev')).toBe(false);
    vi.mocked(console.log).mockClear();
    await initHandler.execute(harness.ctx(flags));
    expect(promptedIds()[0]).toBe(jevId);
    expect(vi.mocked(console.log).mock.calls.flat().join(' ')).toContain('external service');
  });

  it('does not re-offer a worker decline loaded from the existing config field', async () => {
    let existing: ReturnType<typeof emptyConfig> | null = null;
    vi.mocked(readAiwgConfig).mockImplementation(async () => existing);
    vi.mocked(writeAiwgConfig).mockImplementation(async (_root, config) => { existing = config; });
    const inventory = guidedInventory(harness.project);
    const declinePlan = buildInterviewPlan({ inventory, workspaceRoot: harness.project }, {
      [questionId('targets', 'workspaces', harness.project)]: { value: [harness.project], source: 'interview', answeredAt: INTERVIEW_TIME },
      [questionId('tools', 'worker-dispatch', harness.project)]: { value: 'decline', source: 'interview', answeredAt: INTERVIEW_TIME },
    }, INTERVIEW_TIME);
    await planStore.writeSetupPlan(harness.project, declinePlan);
    expect((await setupHandler.execute(harness.ctx(['--apply', '--yes']))).exitCode).toBe(0);
    expect(existing).toMatchObject({ setup: { worker_dispatch_offer: 'declined' } });
    unlinkSync(planPath()); // A new session must recover the preference from config alone.
    vi.mocked(askString).mockResolvedValue('skip');
    await initHandler.execute(harness.ctx(['--scope', 'project', '--jev', 'decline']));
    expect(promptedIds()).not.toContain(questionId('tools', 'worker-dispatch', harness.project));
    expect(stored().answers[questionId('tools', 'worker-dispatch', harness.project)]).toMatchObject({ value: 'decline', source: 'existing-setting' });
  });

  it('supports back and edit, showing the prior answer until it is replaced', async () => {
    const useId = questionId('intent', 'use', harness.project);
    const script = [harness.project, 'skip', 'docs', 'back', 'mixed', 'solo', 'false', '', 'skip', `edit ${useId}`, 'ops', 'false', 'false', 'skip'];
    scripted(script);
    await initHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'project', '--providers', 'codex', '--worker-dispatch', 'decline']));
    expect(script).toEqual([]);
    expect(promptedIds().filter(id => id === useId)).toHaveLength(3);
    expect(vi.mocked(console.log).mock.calls.flat()).toContain('Current: "docs"');
    expect(vi.mocked(console.log).mock.calls.flat()).toContain('Current: "mixed"');
    expect(stored().answers[useId]).toEqual({ value: 'ops', source: 'interview', answeredAt: INTERVIEW_TIME });
  });

  it('resumes only unanswered choices, with deferred credentials first', async () => {
    const flags = ['--jev', 'decline', '--scope', 'project', '--intent', 'docs', '--providers', 'codex', '--worker-dispatch', 'decline', '--default-scripts', 'true'];
    const script = [harness.project, 'skip', 'solo', '', 'defer', 'false', 'skip', 'skip'];
    scripted(script);
    await initHandler.execute(harness.ctx(flags));
    expect(script).toEqual([]);
    const credentialId = questionId('locations', 'credential-source', harness.project, 'codex');
    expect(unansweredPlanChoices(stored()).find(q => q.questionId === credentialId)?.deferredAt).toBe(INTERVIEW_TIME);
    const expected = unansweredPlanChoices(stored()).map(q => q.questionId).sort();
    vi.mocked(console.log).mockClear();
    scripted(['stdin', 'skip', 'skip', 'skip']);
    await initHandler.execute(harness.ctx(flags));
    expect(promptedIds()[0]).toBe(credentialId);
    expect([...promptedIds()].sort()).toEqual(expected);
    expect(stored().answers[credentialId].value).toEqual({ kind: 'credential-ref', source: 'stdin-at-apply', name: 'stdin' });
  });

  it('saves completed blocks and cancel leaves the last successful bytes intact', async () => {
    let checkpoint = '';
    const script = [harness.project, 'skip', 'docs', 'cancel'];
    vi.mocked(askString).mockImplementation(async () => {
      const value = script.shift()!;
      if (value === 'docs') checkpoint = readFileSync(planPath(), 'utf8');
      return value;
    });
    const result = await initHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'project']));
    expect(result.message).toContain('cancelled');
    expect(checkpoint).not.toBe('');
    expect(readFileSync(planPath(), 'utf8')).toBe(checkpoint);
    expect(Object.hasOwn(stored().answers, questionId('intent', 'use', harness.project))).toBe(false);
    expect(stored().answers[questionId('targets', 'workspaces', harness.project)].value).toEqual([harness.project]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('cancel in the first block creates no plan', async () => {
    scripted(['cancel']);
    await initHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'project']));
    expect(existsSync(planPath())).toBe(false);
  });

  it('preserves existing settings without asking, and explicit flags override them', async () => {
    const existing = emptyConfig(['claude']); existing.delivery = { require_signed_commits: false, mode: 'direct' };
    vi.mocked(readAiwgConfig).mockResolvedValue(existing);
    scripted([harness.project, 'skip', 'solo', '', 'skip', 'skip']);
    await initHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'project', '--intent', 'docs', '--providers', 'codex', '--worker-dispatch', 'decline']));
    const plan = stored();
    expect(plan.answers[questionId('tools', 'provider', harness.project, 'codex')].source).toBe('explicit-flag');
    expect(plan.answers[questionId('capabilities', 'delivery', harness.project)].source).toBe('existing-setting');
    expect(promptedIds()).not.toContain(questionId('capabilities', 'delivery', harness.project));
    expect(promptedIds()).not.toContain(questionId('capabilities', 'signing', harness.project));
  });

  it('skipping a required monorepo choice blocks completion and names its flag', async () => {
    const inventory = guidedInventory(harness.project); inventory.projects[0].layout = 'ambiguous';
    vi.mocked(discoverInventory).mockResolvedValue(inventory);
    vi.mocked(askString).mockResolvedValue('skip');
    await expect(initHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'project']))).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('--monorepo') });
  });

  it('re-enters existing settings under --force, including a previously saved session', async () => {
    const existing = emptyConfig(['codex']); existing.delivery = { mode: 'direct', require_signed_commits: false };
    vi.mocked(readAiwgConfig).mockResolvedValue(existing);
    const flags = ['--jev', 'decline', '--scope', 'project', '--providers', 'codex', '--intent', 'docs', '--worker-dispatch', 'decline', '--default-scripts', 'true'];
    scripted([harness.project, 'skip', 'solo', '', 'skip', 'skip']);
    await initHandler.execute(harness.ctx(flags));
    const deliveryId = questionId('capabilities', 'delivery', harness.project);
    expect(stored().answers[deliveryId].source).toBe('existing-setting');
    vi.mocked(console.log).mockClear();
    scripted([harness.project, 'skip', 'solo', '', 'skip', 'false', 'false', 'skip']);
    await initHandler.execute(harness.ctx([...flags, '--force']));
    expect(promptedIds()).toContain(deliveryId);
    expect(stored().answers[deliveryId]).toMatchObject({ value: false, source: 'interview' });
  });

  it('keeps an explicitly edited existing setting on the next resume', async () => {
    const existing = emptyConfig(['codex']); existing.delivery = { mode: 'direct', require_signed_commits: false };
    vi.mocked(readAiwgConfig).mockResolvedValue(existing);
    const flags = ['--jev', 'decline', '--scope', 'project', '--providers', 'codex', '--intent', 'docs', '--worker-dispatch', 'decline', '--default-scripts', 'true'];
    const deliveryId = questionId('capabilities', 'delivery', harness.project);
    scripted([harness.project, 'skip', 'solo', '', 'skip', `edit ${deliveryId}`, '{"mode":"feature-branch","force_push_policy":"never"}', 'skip']);
    await initHandler.execute(harness.ctx(flags));
    vi.mocked(console.log).mockClear();
    scripted(['skip', 'skip', 'skip']);
    await initHandler.execute(harness.ctx(flags));
    expect(promptedIds()).not.toContain(deliveryId);
    expect(stored().answers[deliveryId]).toMatchObject({ value: { mode: 'feature-branch' }, source: 'interview' });
  });

  it('scans more directories only after explicit opt-in and keeps flag answers for newly observed roots', async () => {
    const other = join(harness.scratch, 'other');
    const initial = guidedInventory(harness.project);
    const scanned = { ...initial, projects: [...initial.projects, { ...guidedInventory(other).projects[0], sources: ['selected' as const] }] };
    vi.mocked(discoverInventory).mockResolvedValueOnce(initial).mockResolvedValueOnce(scanned);
    const workspacesId = questionId('targets', 'workspaces', harness.project);
    const script = [harness.project, other, `edit ${workspacesId}`, `${harness.project},${other}`];
    vi.mocked(askString).mockImplementation(async () => script.shift() ?? 'skip');
    await initHandler.execute(harness.ctx(['--jev', 'decline', '--scope', 'project', '--intent', 'docs', '--providers', 'codex', '--default-scripts', 'false', '--worker-dispatch', 'decline']));
    expect(discoverInventory).toHaveBeenNthCalledWith(2, { workspaceRoot: harness.project, roots: [other] });
    expect(stored().answers[questionId('tools', 'provider', other, 'codex')]).toMatchObject({ value: true, source: 'explicit-flag' });
    expect(stored().answers[questionId('tools', 'provider', other, 'claude')]).toMatchObject({ value: false, source: 'explicit-flag' });
    expect(promptedIds()).not.toContain(questionId('tools', 'provider', other, 'claude'));
  });
});
