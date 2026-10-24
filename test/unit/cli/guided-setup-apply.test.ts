import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guidedInventory } from '../../helpers/guided-setup-fixture.js';
import { guidedHarness } from '../../helpers/guided-setup-harness.js';
import { workspaceSlug } from '../../../src/discovery/interview.js';

vi.mock('../../../src/cli/env.js', () => ({ isInteractive: vi.fn() }));
vi.mock('../../../src/cli/prompt-utils.js', async importOriginal => ({ ...await importOriginal<object>(), askString: vi.fn(), createPromptInterface: vi.fn() }));
vi.mock('../../../src/discovery/index.js', async importOriginal => ({ ...await importOriginal<object>(), discoverInventory: vi.fn() }));
vi.mock('../../../src/config/aiwg-config.js', async importOriginal => ({ ...await importOriginal<object>(), readAiwgConfig: vi.fn(), writeAiwgConfig: vi.fn() }));
vi.mock('../../../src/process/bounded-child-process.mjs', () => ({ boundedSpawnSync: vi.fn() }));
import { isInteractive } from '../../../src/cli/env.js';
import { discoverInventory } from '../../../src/discovery/index.js';
import { readAiwgConfig, writeAiwgConfig } from '../../../src/config/aiwg-config.js';
import { boundedSpawnSync } from '../../../src/process/bounded-child-process.mjs';
import { initHandler } from '../../../src/cli/handlers/init.js';
import { setupHandler } from '../../../src/cli/handlers/setup.js';

const SENTINEL_ENV = 'AIWG_TEST_REVIEW_SENTINEL';
const SENTINEL_VALUE = 'canary-apply-probe-value';

let harness: ReturnType<typeof guidedHarness>;
let inventory: ReturnType<typeof guidedInventory>;

function planPath(): string {
  return join(harness.artifacts, 'setup', 'plans', `setup-${workspaceSlug(harness.project)}.json`);
}

function snapshotTree(root: string): Map<string, string> {
  const entries = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const absolute = join(dir, name);
      if (statSync(absolute).isDirectory()) walk(absolute);
      else entries.set(absolute.slice(root.length), readFileSync(absolute, 'utf8'));
    }
  };
  walk(root);
  return entries;
}

async function recordPlan(): Promise<void> {
  await initHandler.execute(harness.ctx(['--scope', 'project', '--providers', 'codex',
    '--credential', `codex=env:${SENTINEL_ENV}`, '--yes']));
  expect(existsSync(planPath())).toBe(true);
}

beforeEach(() => {
  harness = guidedHarness('aiwg-guided-apply-');
  inventory = guidedInventory(harness.project);
  vi.mocked(isInteractive).mockReturnValue(false);
  vi.mocked(discoverInventory).mockImplementation(async () => structuredClone(inventory));
  vi.mocked(readAiwgConfig).mockResolvedValue(null);
  vi.mocked(boundedSpawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '' } as never);
  vi.mocked(writeAiwgConfig).mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv(SENTINEL_ENV, SENTINEL_VALUE);
});

afterEach(() => {
  harness.cleanup();
  vi.unstubAllEnvs();
});

describe('guided setup review and apply', () => {
  it('--review renders per workspace and provider and writes nothing', async () => {
    await recordPlan();
    const before = snapshotTree(harness.scratch);
    const planBytes = readFileSync(planPath(), 'utf8');
    const result = await setupHandler.execute(harness.ctx(['--review']));
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain(`workspace ${harness.project}`);
    expect(result.message).toContain('provider codex');
    expect(result.message).toContain('destination:');
    expect(result.message).toContain('diff:');
    expect(result.message).toContain('readiness');
    expect(result.message).not.toContain(SENTINEL_VALUE);
    expect(snapshotTree(harness.scratch)).toEqual(before);
    expect(readFileSync(planPath(), 'utf8')).toBe(planBytes);
  });

  it('--review --json emits the review schema without the credential value', async () => {
    await recordPlan();
    const before = snapshotTree(harness.scratch);
    const result = await setupHandler.execute(harness.ctx(['--review', '--json']));
    expect(result.exitCode).toBe(0);
    const review = JSON.parse(result.message!);
    expect(review.schema).toBe('aiwg.setup.review.v1');
    expect(review.planId).toBe(`setup-${workspaceSlug(harness.project)}`);
    expect(review.actions.length).toBeGreaterThan(0);
    expect(review.readiness.length).toBeGreaterThan(0);
    expect(result.message).toContain(SENTINEL_ENV);
    expect(result.message).not.toContain(SENTINEL_VALUE);
    expect(snapshotTree(harness.scratch)).toEqual(before);
  });

  it('--dry-run on a saved guided plan previews the review and writes nothing', async () => {
    await recordPlan();
    const before = snapshotTree(harness.scratch);
    const result = await setupHandler.execute(harness.ctx(['--dry-run']));
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain(`workspace ${harness.project}`);
    expect(snapshotTree(harness.scratch)).toEqual(before);
  });

  it('--apply --yes applies core actions through the existing owners', async () => {
    await recordPlan();
    const result = await setupHandler.execute(harness.ctx(['--apply', '--yes']));
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('Applied');
    // Project policy goes through the setup config owner (merged, not invented here).
    expect(writeAiwgConfig).toHaveBeenCalled();
    // configure-provider writes no provider files: a missing provider file is
    // owned by deploy-framework, and the action still applies.
    const providerFile = join(harness.project, 'AGENTS.md');
    expect(existsSync(providerFile)).toBe(false);
    const plan = JSON.parse(readFileSync(planPath(), 'utf8'));
    const receipts = plan.receipts.flatMap((receipt: { actions: Record<string, { status: string; message?: string }> }) =>
      Object.entries(receipt.actions));
    const configured = receipts.find(([id]: [string]) =>
      plan.actions.find((action: { id: string; kind: string }) => action.id === id && action.kind === 'configure-provider'));
    expect(configured[1].status).toBe('applied');
    expect(configured[1].message).toContain('deploy-framework');
    expect(configured[1].message).toContain('nothing written');
    // Receipts persist through the plan store; nothing applied stays eligible.
    const { remainingPlanActions } = await import('../../../src/discovery/plan-store.js');
    expect(remainingPlanActions(plan)).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain(SENTINEL_VALUE);
  });

  it('configure-provider preserves an existing provider file without modifying it', async () => {
    await recordPlan();
    const providerFile = join(harness.project, 'AGENTS.md');
    writeFileSync(providerFile, '# my own config\n');
    const result = await setupHandler.execute(harness.ctx(['--apply', '--yes']));
    expect(result.exitCode).toBe(0);
    expect(readFileSync(providerFile, 'utf8')).toBe('# my own config\n');
    const plan = JSON.parse(readFileSync(planPath(), 'utf8'));
    const messages = plan.receipts.flatMap((receipt: { actions: Record<string, { message?: string }> }) =>
      Object.values(receipt.actions).map(entry => entry.message ?? '')).join('\n');
    expect(messages).toContain('preserved');
  });

  it('configure-provider never creates or modifies a JSON provider config', async () => {
    await recordPlan();
    // Point the recorded provider path at a JSON config (comment lines would corrupt it).
    const settingsPath = join(harness.project, 'settings.json');
    const saved = JSON.parse(readFileSync(planPath(), 'utf8'));
    for (const action of saved.actions) {
      if (action.kind === 'configure-provider') {
        for (const fact of action.dependsOn) if (fact.kind === 'path') fact.path = settingsPath;
      }
    }
    for (const answer of Object.values(saved.answers) as Array<{ value: unknown }>) {
      if (typeof answer.value === 'string' && answer.value.endsWith('AGENTS.md')) answer.value = settingsPath;
    }
    writeFileSync(planPath(), JSON.stringify(saved, null, 2));
    const original = JSON.stringify({ key: 'value' });
    writeFileSync(settingsPath, original);
    const result = await setupHandler.execute(harness.ctx(['--apply', '--yes']));
    expect(result.exitCode).toBe(0);
    // Byte-identical: no comment lines written, still parses as JSON.
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
    expect(() => JSON.parse(readFileSync(settingsPath, 'utf8'))).not.toThrow();
  });

  it('configure-provider writes nothing when the JSON provider config is missing', async () => {
    await recordPlan();
    const settingsPath = join(harness.project, 'settings.json');
    const saved = JSON.parse(readFileSync(planPath(), 'utf8'));
    for (const action of saved.actions) {
      if (action.kind === 'configure-provider') {
        for (const fact of action.dependsOn) if (fact.kind === 'path') fact.path = settingsPath;
      }
    }
    for (const answer of Object.values(saved.answers) as Array<{ value: unknown }>) {
      if (typeof answer.value === 'string' && answer.value.endsWith('AGENTS.md')) answer.value = settingsPath;
    }
    writeFileSync(planPath(), JSON.stringify(saved, null, 2));
    const result = await setupHandler.execute(harness.ctx(['--apply', '--yes']));
    expect(result.exitCode).toBe(0);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('--apply without --yes refuses in a non-interactive context before writing', async () => {
    await recordPlan();
    const planBytes = readFileSync(planPath(), 'utf8');
    await expect(setupHandler.execute(harness.ctx(['--apply']))).rejects.toMatchObject({ code: 'ERR_NON_INTERACTIVE_CONFIRMATION_REQUIRED' });
    expect(writeAiwgConfig).not.toHaveBeenCalled();
    expect(existsSync(join(harness.project, 'AGENTS.md'))).toBe(false);
    expect(readFileSync(planPath(), 'utf8')).toBe(planBytes);
  });

  it('--review without a saved plan names the planning flags', async () => {
    await expect(setupHandler.execute(harness.ctx(['--review']))).rejects.toMatchObject({ code: 'ERR_SETUP_PLAN_NOT_FOUND' });
  });

  it('advertises --review and --apply in setup help and command metadata', async () => {
    const help = (await setupHandler.help!(harness.ctx([]))).message!;
    expect(help).toContain('--review');
    expect(help).toContain('--apply');
    const { setupCommand } = await import('../../../src/extensions/commands/definitions.js');
    expect(JSON.stringify(setupCommand.metadata)).toContain('--review');
    expect(JSON.stringify(setupCommand.metadata)).toContain('--apply');
  });

  it('keeps every apply write inside the scratch roots', async () => {
    await recordPlan();
    await setupHandler.execute(harness.ctx(['--apply', '--yes']));
    const allowed = [harness.project, harness.artifacts, join(harness.scratch, 'memory')].map(root => resolve(root));
    const files: string[] = [];
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const absolute = resolve(dir, name);
        if (statSync(absolute).isDirectory()) walk(absolute);
        else files.push(absolute);
      }
    };
    walk(harness.scratch);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(allowed.some(root => file === root || file.startsWith(`${root}/`))).toBe(true);
    }
  });
});
