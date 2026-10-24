import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyGuidedPlan,
  credentialReferenceFor,
  renderHumanReview,
  reviewGuidedPlan,
  sortPlanActionsForApply,
  type PlanApplyIO,
  type PlanReviewIO,
} from '../../../src/discovery/plan-apply.js';
import { buildInterviewPlan, questionId } from '../../../src/discovery/interview.js';
import { readSetupPlan, remainingPlanActions, revalidateSetupPlan, writeSetupPlan } from '../../../src/discovery/plan-store.js';
import type { DiscoveryInventory } from '../../../src/discovery/types.js';
import type { SetupAnswer, SetupPlan } from '../../../src/discovery/plan-types.js';

const SENTINEL_ENV = 'AIWG_TEST_APPLY_SENTINEL';
const SENTINEL_VALUE = 'canary-apply-probe-value';

let scratch = '';
let project = '';

function inventoryFor(root: string): DiscoveryInventory {
  return {
    projects: [{ root, sources: ['workspace'], vcs: 'git', layout: 'project',
      packageManifest: `${root}/package.json`, workspacePatterns: [], packageRoots: [],
      aiwg: { directory: false, configFile: null, contextFile: null }, providerFiles: [] }],
    tools: ['claude', 'codex'].map(executable => ({ executable, path: `/example/bin/${executable}`,
      installed: 'yes', configured: 'no', authenticated: 'unknown', qualified: 'unknown', version: null, evidence: [] })),
    diagnostics: [], limits: { maxDepth: 4, maxEntries: 20000, timeBudgetMs: 2000, maxFileBytes: 262144 },
    stats: { entriesInspected: 5, elapsedMs: 1, truncated: false },
  };
}

function answer(value: SetupAnswer['value']): SetupAnswer {
  return { value, source: 'interview', answeredAt: new Date().toISOString() };
}

/** A plan with configure + verify + write-config + register + deploy for one provider. */
function buildPlan(inventory: DiscoveryInventory): SetupPlan {
  const root = inventory.projects[0].root;
  return buildInterviewPlan({ inventory, workspaceRoot: root }, {
    [questionId('targets', 'workspaces', root)]: answer([root]),
    [questionId('targets', 'scope')]: answer('project'),
    [questionId('intent', 'use', root)]: answer('code'),
    [questionId('tools', 'provider', root, 'codex')]: answer(true),
    [questionId('locations', 'config-dir', root, 'codex')]: answer(join(root, 'AGENTS.md')),
    [questionId('locations', 'credential-source', root, 'codex')]: answer({ kind: 'credential-ref', source: 'env', name: SENTINEL_ENV }),
  }, new Date().toISOString());
}

function reviewIO(): PlanReviewIO {
  return {
    exists: async path => { try { await stat(path); return true; } catch { return false; } },
    installMode: async () => ({ devMode: false, method: 'test', root: '' }),
  };
}

function applyIO(overrides: Partial<PlanApplyIO['owners']> = {}, saves: SetupPlan[] = []): PlanApplyIO {
  return {
    ...reviewIO(),
    readEnv: name => process.env[name],
    readCredentialFile: async path => readFileSync(path, 'utf8'),
    now: () => new Date().toISOString(),
    save: async next => { saves.push(next); },
    owners: {
      configureProvider: async ({ configPath }) => `configured ${configPath}`,
      verifyProvider: async ({ action }) => `verified ${action.provider}`,
      writeProjectConfig: async ({ action }) => `wrote config for ${action.workspace}`,
      deployFramework: async ({ action }) => `deployed for ${action.provider}`,
      registerProject: async ({ action }) => `registered ${action.workspace}`,
      recordDecline: async () => 'recorded decline',
      ...overrides,
    },
  };
}

/** Every file under a directory mapped to its bytes. */
function snapshotTree(root: string): Map<string, string> {
  const entries = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const absolute = join(dir, name);
      if (statSync(absolute).isDirectory()) walk(absolute);
      else entries.set(absolute.slice(root.length), readFileSync(absolute, 'utf8'));
    }
  };
  walk(root);
  return entries;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'aiwg-plan-apply-'));
  project = join(scratch, 'project');
  mkdirSync(project, { recursive: true });
  vi.stubEnv('HOME', join(scratch, 'home'));
  vi.stubEnv('XDG_CONFIG_HOME', join(scratch, 'config'));
  vi.stubEnv('AIWG_PROJECT_MEMORY_HOME', join(scratch, 'memory'));
  vi.stubEnv('AIWG_ARTIFACTS_PATH', '');
  vi.stubEnv('AIWG_PROJECT_ARTIFACTS_PATH', '');
  vi.stubEnv('AIWG_PROJECT_AIWG_DIR', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe('guided plan review (dry run)', () => {
  it('never uses another workspace credential and resolves selected packages through their owning project', () => {
    const inventory = inventoryFor(project);
    const other = `${project}-other`;
    inventory.projects.push(inventoryFor(other).projects[0]);
    inventory.projects[0].packageRoots = [join(project, 'packages', 'app')];
    const plan = buildPlan(inventory);
    const reference = { kind: 'credential-ref', source: 'env', name: SENTINEL_ENV };
    expect(credentialReferenceFor(plan, project, 'codex')).toEqual(reference);
    expect(credentialReferenceFor(plan, inventory.projects[0].packageRoots[0], 'codex')).toEqual(reference);
    expect(credentialReferenceFor(plan, other, 'codex')).toBeUndefined();
    expect(credentialReferenceFor(plan, project, 'jev')).toBeUndefined();
    const selectedPackage = inventory.projects[0].packageRoots[0];
    plan.inventory.projects.push(inventoryFor(selectedPackage).projects[0]);
    plan.answers[questionId('targets', 'root', project)] = answer(selectedPackage);
    expect(credentialReferenceFor(plan, selectedPackage, 'codex')).toEqual(reference);
  });

  it('renders per workspace and provider without writing anything', async () => {
    const inventory = inventoryFor(project);
    const plan = buildPlan(inventory);
    expect(plan.actions.map(action => action.kind).sort()).toEqual(
      ['configure-provider', 'deploy-framework', 'register-project', 'verify-provider', 'write-project-config']);
    const before = snapshotTree(scratch);
    const review = await reviewGuidedPlan(plan, inventory, reviewIO());
    expect(snapshotTree(scratch)).toEqual(before);
    const human = renderHumanReview(review);
    expect(human).toContain(`workspace ${project}`);
    expect(human).toContain('provider codex');
    expect(human).toContain('provider shared');
    expect(human).toContain('destination:');
    expect(human).toContain('diff:');
    expect(human).toContain('readiness');
    expect(review.schema).toBe('aiwg.setup.review.v1');
    expect(review.actions.every(action => action.status === 'ready')).toBe(true);
    expect(JSON.stringify(review)).not.toContain(SENTINEL_VALUE);
    expect(human).not.toContain(SENTINEL_VALUE);
  });

  it('treats an existing provider file as ready: configure-provider preserves it and never overwrites', async () => {
    const inventory = inventoryFor(project);
    const plan = buildPlan(inventory);
    writeFileSync(join(project, 'AGENTS.md'), '# my own config\n');
    const review = await reviewGuidedPlan(plan, inventory, reviewIO());
    const configured = review.actions.find(action => action.kind === 'configure-provider')!;
    expect(configured.status).toBe('ready');
    expect(configured.conflicts).toEqual([]);
    expect(review.conflicts).toEqual([]);
  });

  it('ignores provider path-fact changes for configure-provider (the owner re-checks the filesystem at apply time)', async () => {
    const inventory = inventoryFor(project);
    const plan = buildPlan(inventory);
    // The provider file appeared after planning: discovery now observes it.
    const observed = structuredClone(inventory);
    observed.projects[0].providerFiles.push({ provider: 'codex', path: join(project, 'AGENTS.md'), kind: 'context' });
    const review = await reviewGuidedPlan(plan, observed, reviewIO());
    const configured = review.actions.find(action => action.kind === 'configure-provider')!;
    expect(configured.status).toBe('ready');
    expect(configured.stale).toBeUndefined();
  });

  it('orders configure-provider before deploy-framework for the same workspace and provider', async () => {
    const inventory = inventoryFor(project);
    const plan = buildPlan(inventory);
    const pair = plan.actions.filter(action => action.provider === 'codex' &&
      (action.kind === 'configure-provider' || action.kind === 'deploy-framework'));
    expect(pair.map(action => action.kind).sort()).toEqual(['configure-provider', 'deploy-framework']);
    const sorted = sortPlanActionsForApply([...pair].reverse());
    expect(sorted.map(action => action.kind)).toEqual(['configure-provider', 'deploy-framework']);
  });

  it('gates configure-provider on an unanswered credential question', async () => {
    const inventory = inventoryFor(project);
    const root = inventory.projects[0].root;
    const answers = {
      [questionId('targets', 'workspaces', root)]: answer([root]),
      [questionId('tools', 'provider', root, 'codex')]: answer(true),
      [questionId('locations', 'config-dir', root, 'codex')]: answer(join(root, 'AGENTS.md')),
    };
    const plan = buildInterviewPlan({ inventory, workspaceRoot: root }, answers, new Date().toISOString());
    const review = await reviewGuidedPlan(plan, inventory, reviewIO());
    expect(review.actions.find(action => action.kind === 'configure-provider')?.status).toBe('needs-credential');
  });
});

describe('guided plan apply', () => {
  it('recognizes its own saved plan directory without accepting unrelated directory creation', async () => {
    vi.stubEnv(SENTINEL_ENV, SENTINEL_VALUE);
    const inventory = inventoryFor(project);
    const plan = buildPlan(inventory);
    const fresh = structuredClone(inventory);
    fresh.projects[0].aiwg.directory = true;
    const beforeSave = await reviewGuidedPlan(plan, fresh, reviewIO());
    expect(beforeSave.actions.find(action => action.kind === 'register-project')?.status).toBe('stale');
    await writeSetupPlan(project, plan, {});
    const saved = await readSetupPlan(project, plan.id, {});
    const review = await reviewGuidedPlan(saved, fresh, reviewIO());
    expect(review.actions.every(action => action.status === 'ready')).toBe(true);
    const io = applyIO();
    io.save = async next => { await writeSetupPlan(project, next, {}); };
    const applied = await applyGuidedPlan(saved, fresh, io);
    expect(applied.result.classification).toBe('success');
    expect(remainingPlanActions(await readSetupPlan(project, plan.id, {}))).toEqual([]);
  });

  it('re-applying a successful persisted plan writes nothing and retains applied receipts', async () => {
    vi.stubEnv(SENTINEL_ENV, SENTINEL_VALUE);
    const inventory = inventoryFor(project);
    const plan = buildPlan(inventory);
    const io = applyIO();
    io.save = async next => { await writeSetupPlan(project, next); };
    const applied = await applyGuidedPlan(plan, inventory, io);
    const saved = await readSetupPlan(project, plan.id);
    const before = snapshotTree(scratch);
    io.save = vi.fn(io.save);
    for (const key of Object.keys(io.owners) as Array<keyof typeof io.owners>) io.owners[key] = vi.fn(io.owners[key]) as never;
    const rerun = await applyGuidedPlan(saved, inventory, io);
    expect(rerun.result).toMatchObject({ classification: 'success', exitCode: 0, results: [] });
    expect(rerun.plan).toEqual(applied.plan);
    expect(remainingPlanActions(rerun.plan)).toEqual([]);
    expect(rerun.plan.receipts.flatMap(receipt => Object.values(receipt.actions)).every(receipt => receipt.status === 'applied')).toBe(true);
    expect(io.save).not.toHaveBeenCalled();
    for (const owner of Object.values(io.owners)) expect(owner).not.toHaveBeenCalled();
    expect(snapshotTree(scratch)).toEqual(before);
  });

  it('retries only failed and skipped actions after partial progress', async () => {
    const inventory = inventoryFor(project);
    const io = applyIO({ deployFramework: async () => { throw new Error('synthetic deploy failure'); } });
    io.readEnv = () => undefined;
    io.save = async next => { await writeSetupPlan(project, next); };
    const first = await applyGuidedPlan(buildPlan(inventory), inventory, io);
    expect(first.result.results.filter(result => result.status !== 'applied').map(result => result.status)).toEqual(['skipped', 'failed']);
    const pending = remainingPlanActions(first.plan);
    const fresh = structuredClone(inventory);
    fresh.projects[0].aiwg = { directory: true, configFile: join(project, '.aiwg', 'aiwg.config'), contextFile: null };
    const retry = applyIO();
    retry.readEnv = () => SENTINEL_VALUE;
    retry.save = async next => { await writeSetupPlan(project, next); };
    for (const key of Object.keys(retry.owners) as Array<keyof typeof retry.owners>) retry.owners[key] = vi.fn(retry.owners[key]) as never;
    const second = await applyGuidedPlan(await readSetupPlan(project, first.plan.id), fresh, retry);
    expect(second.result.classification).toBe('success');
    expect(second.result.results.map(result => result.actionId)).toEqual(sortPlanActionsForApply(pending).map(action => action.id));
    expect(retry.owners.configureProvider).toHaveBeenCalledOnce();
    expect(retry.owners.deployFramework).toHaveBeenCalledOnce();
    expect(retry.owners.writeProjectConfig).not.toHaveBeenCalled();
    expect(retry.owners.registerProject).not.toHaveBeenCalled();
    expect(remainingPlanActions(second.plan)).toEqual([]);
  });

  it.each(['configure-provider', 'write-project-config', 'deploy-framework', 'configure-jev', 'configure-worker-dispatch'])(
    'resumes persisted receipts after interruption following %s without replaying that action', async kind => {
      vi.stubEnv(SENTINEL_ENV, SENTINEL_VALUE);
      const inventory = inventoryFor(project);
      const original = buildPlan(inventory);
      original.answers[questionId('capabilities', 'jev', project)] = answer('enable');
      original.answers[questionId('locations', 'credential-source', project, 'jev')] = answer({ kind: 'credential-ref', source: 'env', name: SENTINEL_ENV });
      original.answers[questionId('tools', 'worker-dispatch', project)] = answer('enable');
      const plan = buildInterviewPlan({ inventory, workspaceRoot: project }, original.answers, original.createdAt);
      const io = applyIO({ configureJev: async () => {}, configureWorkerDispatch: async () => {} });
      let interrupted = false;
      io.save = async next => {
        await writeSetupPlan(project, next);
        const action = next.actions.find(action => action.kind === kind)!;
        if (!interrupted && next.receipts.some(receipt => receipt.actions[action.id]?.status === 'applied')) {
          interrupted = true;
          throw new Error('synthetic interruption between actions');
        }
      };
      await expect(applyGuidedPlan(plan, inventory, io)).rejects.toThrow('synthetic interruption');
      const saved = await readSetupPlan(project, plan.id);
      const completed = saved.receipts.flatMap(receipt => Object.keys(receipt.actions));
      expect(completed).toContain(plan.actions.find(action => action.kind === kind)!.id);
      expect(saved.receipts.flatMap(receipt => Object.values(receipt.actions)).every(receipt => receipt.status === 'applied')).toBe(true);
      const pending = remainingPlanActions(saved);
      const fresh = structuredClone(inventory);
      if (completed.some(id => plan.actions.find(action => action.id === id)?.kind === 'write-project-config')) {
        fresh.projects[0].aiwg = { directory: true, configFile: join(project, '.aiwg', 'aiwg.config'), contextFile: null };
      }
      const retry = applyIO({ configureJev: async () => {}, configureWorkerDispatch: async () => {} });
      retry.save = async next => { await writeSetupPlan(project, next); };
      const resumed = await applyGuidedPlan(saved, fresh, retry);
      expect(resumed.result.classification).toBe('success');
      expect(resumed.result.results.map(result => result.actionId)).toEqual(sortPlanActionsForApply(pending).map(action => action.id));
      expect(remainingPlanActions(await readSetupPlan(project, plan.id))).toEqual([]);
    });

  it('aborts on receipt persistence failure without continuing owners or overwriting the prior snapshot', async () => {
    vi.stubEnv(SENTINEL_ENV, SENTINEL_VALUE);
    const inventory = inventoryFor(project);
    const plan = buildPlan(inventory);
    await writeSetupPlan(project, plan);
    const verify = vi.fn(async () => 'verified');
    const io = applyIO({ verifyProvider: verify });
    io.save = vi.fn(async () => { throw new Error('synthetic disk failure'); });
    await expect(applyGuidedPlan(plan, inventory, io)).rejects.toThrow('synthetic disk failure');
    expect(io.save).toHaveBeenCalledOnce();
    expect(verify).not.toHaveBeenCalled();
    expect(await readSetupPlan(project, plan.id)).toEqual(plan);
  });

  it('permits only receipt-backed config creation and refuses unrelated environment changes', async () => {
    vi.stubEnv(SENTINEL_ENV, SENTINEL_VALUE);
    const inventory = inventoryFor(project);
    const plan = buildPlan(inventory);
    const fresh = structuredClone(inventory);
    fresh.projects[0].aiwg = { directory: true, configFile: join(project, '.aiwg', 'aiwg.config'), contextFile: null };
    expect(revalidateSetupPlan(plan, fresh).filter(change => change.changes.some(entry => entry.fact.kind === 'path'))
      .map(change => plan.actions.find(action => action.id === change.actionId)?.kind)).toEqual(['write-project-config', 'register-project']);
    const { plan: progressed } = await applyGuidedPlan(plan, inventory, applyIO());
    expect(revalidateSetupPlan(progressed, fresh).filter(change => change.changes.some(entry => entry.fact.kind === 'path'))).toEqual([]);
    // A successful config receipt establishes presence, even if the path was
    // absent in the original snapshot. Its later disappearance must block retries.
    expect(revalidateSetupPlan(progressed, inventory).filter(change => change.changes.some(entry => entry.fact.kind === 'path')))
      .toEqual(expect.arrayContaining([expect.objectContaining({ changes: [expect.objectContaining({ reason: 'path-missing', before: true, after: false })] })]));
    const changed = structuredClone(fresh);
    changed.projects[0].packageManifest = null;
    changed.projects[0].layout = 'monorepo';
    changed.tools[1].installed = 'no';
    expect(revalidateSetupPlan(progressed, changed).flatMap(action => action.changes.map(change => change.reason)))
      .toEqual(expect.arrayContaining(['path-missing', 'fact-changed', 'tool-not-installed']));
    // Retrying an unapplied action still refuses changed facts even with other applied receipts.
    const target = progressed.actions.find(action => action.kind === 'deploy-framework')!;
    for (const receipt of progressed.receipts) delete receipt.actions[target.id];
    const deploy = vi.fn(async () => 'deployed');
    const refused = await applyGuidedPlan(progressed, changed, applyIO({ deployFramework: deploy }));
    expect(refused.result.results).toEqual([expect.objectContaining({ status: 'skipped', message: expect.stringContaining('re-run discovery and the setup interview') })]);
    expect(deploy).not.toHaveBeenCalled();
  });

  it('reports partial success when an optional integration fails, keeping it eligible', async () => {
    vi.stubEnv(SENTINEL_ENV, SENTINEL_VALUE);
    const inventory = inventoryFor(project);
    const saves: SetupPlan[] = [];
    const deploy = vi.fn(async () => { throw new Error('integration exploded'); });
    const { plan: applied, result } = await applyGuidedPlan(planForApply(inventory),
      inventory, applyIO({ deployFramework: deploy }, saves));
    expect(result.classification).toBe('partial');
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('Partial success');
    const failed = result.results.find(entry => entry.kind === 'deploy-framework')!;
    expect(failed.status).toBe('failed');
    expect(failed.optional).toBe(true);
    expect(result.results.filter(entry => !entry.optional).every(entry => entry.status === 'applied')).toBe(true);
    // The failed optional action stays eligible for a later run.
    expect(remainingPlanActions(applied).map(action => action.id)).toContain(failed.actionId);
    expect(remainingPlanActions(applied).every(action => action.kind === 'deploy-framework')).toBe(true);
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(saves.length).toBeGreaterThan(0);
    // Truthful per-integration status in the persisted receipts.
    const receipts = applied.receipts.flatMap(receipt => Object.entries(receipt.actions));
    expect(receipts.find(([id, receipt]) => id === failed.actionId && receipt.status === 'failed')).toBeTruthy();
  });

  it('refuses actions whose facts are stale with a re-run message and calls no owner', async () => {
    vi.stubEnv(SENTINEL_ENV, SENTINEL_VALUE);
    const inventory = inventoryFor(project);
    const stale = inventoryFor(project);
    stale.tools = stale.tools.map(tool => tool.executable === 'codex' ? { ...tool, installed: 'no' as const } : tool);
    const configure = vi.fn(async () => 'configured');
    const { result } = await applyGuidedPlan(planForApply(inventory), stale, applyIO({ configureProvider: configure }));
    const refused = result.results.find(entry => entry.kind === 'configure-provider')!;
    expect(refused.status).toBe('skipped');
    expect(refused.message).toContain('re-run discovery');
    expect(configure).not.toHaveBeenCalled();
    expect(result.classification).toBe('failure');
  });

  it.each(['lost-version', 'unobserved-layout'] as const)('refuses %s instead of treating every unknown fact as advisory', async condition => {
    vi.stubEnv(SENTINEL_ENV, SENTINEL_VALUE);
    const inventory = inventoryFor(project);
    inventory.tools[1].version = '1.0.0';
    const plan = buildPlan(inventory);
    const fresh = structuredClone(inventory);
    if (condition === 'lost-version') fresh.tools[1].version = null;
    else {
      fresh.projects = [];
      fresh.stats.truncated = true;
    }
    const verify = vi.fn(async () => 'verified');
    const review = await reviewGuidedPlan(plan, fresh, reviewIO());
    expect(review.actions.find(action => action.kind === 'verify-provider')?.status).toBe('stale');
    const { result } = await applyGuidedPlan(plan, fresh, applyIO({ verifyProvider: verify }));
    expect(result.results.find(action => action.kind === 'verify-provider')?.status).toBe('skipped');
    expect(verify).not.toHaveBeenCalled();
  });

  it('resolves env credentials at apply time without persisting or printing the value', async () => {
    vi.stubEnv(SENTINEL_ENV, SENTINEL_VALUE);
    const inventory = inventoryFor(project);
    const saves: SetupPlan[] = [];
    const { plan: applied, result } = await applyGuidedPlan(planForApply(inventory),
      inventory, applyIO({}, saves));
    expect(result.classification).toBe('success');
    const serialized = JSON.stringify(saves.at(-1));
    expect(serialized).toContain(SENTINEL_ENV);
    expect(serialized).not.toContain(SENTINEL_VALUE);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_VALUE);
    expect(renderHumanReview(await reviewGuidedPlan(applied, inventory, reviewIO()))).not.toContain(SENTINEL_VALUE);
  });

  it('refuses stdin-at-apply credentials headless without touching the secret', async () => {
    const inventory = inventoryFor(project);
    const root = inventory.projects[0].root;
    const plan = buildInterviewPlan({ inventory, workspaceRoot: root }, {
      [questionId('targets', 'workspaces', root)]: answer([root]),
      [questionId('tools', 'provider', root, 'codex')]: answer(true),
      [questionId('locations', 'config-dir', root, 'codex')]: answer(join(root, 'AGENTS.md')),
      [questionId('locations', 'credential-source', root, 'codex')]: answer({ kind: 'credential-ref', source: 'stdin-at-apply', name: 'stdin' }),
    }, new Date().toISOString());
    const configure = vi.fn(async () => 'configured');
    const { result } = await applyGuidedPlan(plan, inventory, applyIO({ configureProvider: configure }));
    const refused = result.results.find(entry => entry.kind === 'configure-provider')!;
    expect(refused.status).toBe('skipped');
    expect(refused.message).toContain('Stdin-at-apply');
    expect(configure).not.toHaveBeenCalled();
  });

  function planForApply(inventory: DiscoveryInventory): SetupPlan {
    return buildPlan(inventory);
  }
});
