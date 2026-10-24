import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyGuidedPlan,
  renderHumanReview,
  reviewGuidedPlan,
  sortPlanActionsForApply,
  type PlanApplyIO,
  type PlanReviewIO,
} from '../../../src/discovery/plan-apply.js';
import { buildInterviewPlan, questionId } from '../../../src/discovery/interview.js';
import { remainingPlanActions } from '../../../src/discovery/plan-store.js';
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
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe('guided plan review (dry run)', () => {
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
