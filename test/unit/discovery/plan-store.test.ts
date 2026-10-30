import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateSetupPlan, readSetupPlan, writeSetupPlan, remainingPlanActions,
  unansweredPlanChoices, revalidateSetupPlan, type SetupPlan } from '../../../src/discovery/index.js';

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}));

const fixture = fileURLToPath(new URL('./fixtures/setup-plan-v1.json', import.meta.url));
let scratch: string;
let project: string;
let root: string;
let plan: SetupPlan;
beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'aiwg-plan-store-'));
  project = join(scratch, 'project');
  root = join(scratch, 'artifacts');
  await fs.mkdir(project);
  await fs.mkdir(root);
  vi.stubEnv('HOME', join(scratch, 'home'));
  vi.stubEnv('XDG_CONFIG_HOME', join(scratch, 'config'));
  vi.stubEnv('AIWG_PROJECT_MEMORY_HOME', join(scratch, 'memory'));
  vi.stubEnv('AIWG_ARTIFACTS_PATH', root);
  vi.stubEnv('AIWG_PROJECT_ARTIFACTS_PATH', '');
  vi.stubEnv('AIWG_PROJECT_AIWG_DIR', '');
  plan = JSON.parse(await fs.readFile(fixture, 'utf8')) as SetupPlan;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(scratch, { recursive: true, force: true });
});

async function storedBytes(): Promise<string> {
  return fs.readFile(join(root, 'setup', 'plans', `${plan.id}.json`), 'utf8');
}
async function rawPlan(value: unknown): Promise<void> {
  const path = join(root, 'setup', 'plans', `${plan.id}.json`);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(value));
}

describe('versioned setup plan store', () => {
  it('writes the golden v1 JSON bytes under the resolved root and roundtrips', async () => {
    expect(await writeSetupPlan(project, plan)).toBe(join(root, 'setup', 'plans', 'setup-demo.json'));
    expect(await storedBytes()).toBe(await fs.readFile(fixture, 'utf8'));
    expect(await readSetupPlan(project, plan.id)).toEqual(plan);
    await expect(fs.stat(join(project, '.aiwg'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(join(root, 'setup', 'plans', 'setup-demo.json'))).mode & 0o777).toBe(0o600);
  });

  it('migrates the v0 fixture explicitly without rewriting it on read', async () => {
    const older = JSON.parse(await fs.readFile(new URL('./fixtures/setup-plan-v0.json', import.meta.url), 'utf8'));
    expect(migrateSetupPlan(older)).toEqual(plan);
    await rawPlan(older);
    const before = await storedBytes();
    expect(await readSetupPlan(project, plan.id)).toEqual(plan);
    expect(await storedBytes()).toBe(before);
  });

  it('refuses future schema versions with an upgrade diagnostic', async () => {
    await rawPlan({ ...plan, schemaVersion: 999 });
    await expect(readSetupPlan(project, plan.id)).rejects.toThrow(/999.*newer.*1.*upgrade/i);
  });

  it.each([undefined, -1, '1', 1.5])('refuses invalid schemaVersion %s', async schemaVersion => {
    await rawPlan({ ...plan, schemaVersion });
    await expect(readSetupPlan(project, plan.id)).rejects.toThrow(/schemaVersion/);
  });

  it('rejects malformed plans and receipts that could hide or repeat actions', async () => {
    for (const value of [
      { schemaVersion: 1 },
      { ...plan, actions: [...plan.actions, plan.actions[0]] },
      { ...plan, receipts: [{ workspace: '/wrong', actions: { configure: {
        status: 'applied', startedAt: plan.createdAt, completedAt: plan.createdAt,
      } } }] },
      { ...plan, inventory: { ...plan.inventory, tools: [{}] } },
    ]) {
      await rawPlan(value);
      await expect(readSetupPlan(project, plan.id)).rejects.toThrow(/plan/i);
    }
  });

  it('refuses invalid JSON and mismatched plan IDs', async () => {
    await writeSetupPlan(project, plan);
    await fs.writeFile(join(root, 'setup', 'plans', `${plan.id}.json`), '{broken');
    await expect(readSetupPlan(project, plan.id)).rejects.toThrow(/valid JSON/);
    await rawPlan({ ...plan, id: 'different' });
    await expect(readSetupPlan(project, plan.id)).rejects.toThrow(/filename/);
  });

  it('keeps the prior complete plan and removes the temp file on failed rename', async () => {
    await writeSetupPlan(project, plan);
    const before = await storedBytes();
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'EIO' }));
    await expect(writeSetupPlan(project, { ...plan, updatedAt: '2026-10-24T13:00:00.000Z' })).rejects.toThrow(/attached and writable/);
    expect(await storedBytes()).toBe(before);
    expect(await fs.readdir(join(root, 'setup', 'plans'))).toEqual(['setup-demo.json']);
  });

  it('replaces a complete plan atomically with updated receipts', async () => {
    await writeSetupPlan(project, plan);
    plan.receipts = [{ workspace: plan.actions[0].workspace, actions: { configure: {
      status: 'applied', startedAt: plan.createdAt, completedAt: plan.createdAt,
    } } }];
    await writeSetupPlan(project, plan);
    expect(await readSetupPlan(project, plan.id)).toEqual(plan);
    expect(await fs.readdir(join(root, 'setup', 'plans'))).toEqual(['setup-demo.json']);
  });
});

describe('credential exclusion', () => {
  it.each<[string, SetupPlan['answers'][string]['value']]>([
    ['password', 'short'], ['token', 'opaque'], ['secret', 1234], ['apiKey', 'ordinary-looking'],
    ['nested', { password: 'nested-value' }], ['nested', { nested: ['ghp_abcdefgh1234567890'] }],
    ['nested', { password: { value: { kind: 'credential-ref', source: 'env', name: 'PASSWORD' }, answeredAt: '2026-10-24T12:00:00.000Z', raw: 'hidden-value' } }],
    ['nested', 'sk-proj-abcdef1234567890'], ['nested', 'Bearer abcdef1234567890'],
    ['nested', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh12345678'],
    ['nested', 'nZ4Qa8Vm2Rp7Lx5Bc9Kd1Tg6Hs3Jw0Ef'],
  ])('rejects secret-looking answer %s before writing any bytes', async (key, value) => {
    await writeSetupPlan(project, plan);
    const before = await storedBytes();
    plan.answers[key] = { value, source: 'interview', answeredAt: plan.createdAt };
    await expect(writeSetupPlan(project, plan)).rejects.toThrow(/credential-ref/);
    expect(await storedBytes()).toBe(before);
    expect(await storedBytes()).not.toContain(typeof value === 'string' ? value : JSON.stringify(value));
    expect(await fs.readdir(join(root, 'setup', 'plans'))).toEqual(['setup-demo.json']);
  });

  it('rejects evidence, receipt messages, and object keys containing tokens', async () => {
    const secret = 'sk-proj-abcdef1234567890';
    for (const mutate of [
      (p: SetupPlan) => { p.inventory.tools[0].evidence.push(secret); },
      (p: SetupPlan) => { p.answers[secret] = { value: true, source: 'default', answeredAt: p.createdAt }; },
      (p: SetupPlan) => { p.receipts = [{ workspace: p.actions[0].workspace, actions: { configure: {
        status: 'failed', startedAt: p.createdAt, completedAt: p.createdAt, message: secret,
      } } }]; },
    ]) {
      const candidate = structuredClone(plan);
      mutate(candidate);
      await expect(writeSetupPlan(project, candidate)).rejects.toThrow(/credential-ref/);
    }
    await expect(fs.stat(join(root, 'setup'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows only the exact credential reference shape and scans its name', async () => {
    for (const source of ['env', 'file', 'stdin-at-apply'] as const) {
      plan.answers.apiKey.value = { kind: 'credential-ref', source, name: source === 'file' ? '/example/credentials.json' : 'OPENAI_API_KEY' };
      await writeSetupPlan(project, plan);
      expect((await readSetupPlan(project, plan.id)).answers.apiKey).toEqual(plan.answers.apiKey);
    }
    plan.answers.apiKey.value = { kind: 'credential-ref', source: 'env', name: 'OPENAI_API_KEY', token: 'hidden' };
    await expect(writeSetupPlan(project, plan)).rejects.toThrow(/credential-ref/);
    plan.answers.apiKey.value = { kind: 'credential-ref', source: 'env', name: 'sk-proj-abcdef1234567890' };
    await expect(writeSetupPlan(project, plan)).rejects.toThrow(/credential-ref/);
  });

  it('refuses credential values embedded in recommendations and choice defaults/options', async () => {
    const secret = 'tiny-value';
    plan.recommendations.push({ questionId: 'apiKey', value: secret, reason: 'Unsafe default' });
    await expect(writeSetupPlan(project, plan)).rejects.toThrow(/credential-ref/);
    plan.recommendations.pop();
    plan.unresolvedChoices.push({ questionId: 'password', options: [{ label: 'Unsafe', value: secret }],
      default: null, whyItMatters: 'Requires a reference' });
    await expect(writeSetupPlan(project, plan)).rejects.toThrow(/credential-ref/);
    plan.unresolvedChoices.at(-1)!.options[0].value = { kind: 'credential-ref', source: 'stdin-at-apply', name: 'Password input' };
    plan.unresolvedChoices.at(-1)!.default = secret;
    await expect(writeSetupPlan(project, plan)).rejects.toThrow(/credential-ref/);
    await expect(fs.stat(join(root, 'setup'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('guards the serialized snapshot when toJSON introduces a secret', async () => {
    const candidate = Object.assign(structuredClone(plan), {
      toJSON: () => ({ ...plan, answers: { ...plan.answers, extra: { value: 'sk-proj-abcdef1234567890', source: 'default', answeredAt: plan.createdAt } } }),
    });
    await expect(writeSetupPlan(project, candidate)).rejects.toThrow(/credential-ref/);
    await expect(fs.stat(join(root, 'setup'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('resume and inventory revalidation', () => {
  it('resumes a persisted half-applied plan, retaining every answered question', async () => {
    for (const [index, source] of ['explicit-flag', 'existing-setting', 'interview', 'default', 'discovered'].entries()) {
      const questionId = `answered-${index}`;
      plan.answers[questionId] = { value: index % 2 ? null : false, source: source as SetupPlan['answers'][string]['source'], answeredAt: plan.createdAt };
      plan.unresolvedChoices.push({ ...plan.unresolvedChoices[0], questionId });
    }
    plan.unresolvedChoices.push({ ...plan.unresolvedChoices[0], questionId: 'provider' });
    plan.receipts = [{ workspace: plan.actions[0].workspace, actions: {
      configure: { status: 'applied', startedAt: plan.createdAt, completedAt: plan.createdAt },
      verify: { status: 'failed', startedAt: plan.createdAt, completedAt: plan.createdAt },
    } }];
    await writeSetupPlan(project, plan);
    const resumed = await readSetupPlan(project, plan.id);
    const before = structuredClone(resumed);
    expect(remainingPlanActions(resumed).map(action => action.id)).toEqual(['verify']);
    expect(unansweredPlanChoices(resumed).map(choice => choice.questionId)).toEqual(['scope']);
    expect(resumed.answers.provider.source).toBe('explicit-flag');
    expect(resumed).toEqual(before);
    resumed.receipts[0].actions.verify.status = 'skipped';
    expect(remainingPlanActions(resumed).map(action => action.id)).toEqual(['verify']);
  });

  it('isolates receipts by workspace and uses own answer properties', () => {
    plan.actions.push({ ...plan.actions[0], id: 'elsewhere', workspace: '/example/other' });
    plan.receipts = [{ workspace: '/example/other', actions: { configure: {
      status: 'applied', startedAt: plan.createdAt, completedAt: plan.createdAt,
    } } }];
    plan.unresolvedChoices.push({ ...plan.unresolvedChoices[0], questionId: 'toString' });
    expect(remainingPlanActions(plan)).toEqual(plan.actions);
    expect(unansweredPlanChoices(plan)).toHaveLength(2);
  });

  it('reports changed path, version, and layout facts per dependent action', () => {
    expect(revalidateSetupPlan(plan, structuredClone(plan.inventory))).toEqual([]);
    const fresh = structuredClone(plan.inventory);
    fresh.projects[0].packageManifest = null;
    fresh.projects[0].layout = 'monorepo';
    fresh.tools[0].version = '2.0.0';
    expect(revalidateSetupPlan(plan, fresh).map(result => [result.actionId, result.changes.map(change => change.reason)])).toEqual([
      ['configure', ['path-missing', 'version-changed']], ['verify', ['fact-changed']],
    ]);
    expect(revalidateSetupPlan(plan, fresh)[0].changes[1]).toMatchObject({ before: '1.0.0', after: '2.0.0' });
  });

  it('flags tools no longer installed even for a version dependency', () => {
    const fresh = structuredClone(plan.inventory);
    fresh.tools[0].installed = 'no';
    fresh.tools[0].path = null;
    fresh.tools[0].version = null;
    expect(revalidateSetupPlan(plan, fresh)).toMatchObject([{ actionId: 'configure', changes: [{ reason: 'tool-not-installed' }] }]);
  });

  it('reports missing workspaces and treats partial or unknown facts as unobserved', () => {
    const fresh = structuredClone(plan.inventory);
    fresh.projects = [];
    expect(revalidateSetupPlan(plan, fresh).map(result => result.changes[0].reason)).toEqual(['path-missing', 'path-missing']);
    fresh.stats.truncated = true;
    fresh.tools[0].installed = 'unknown';
    expect(revalidateSetupPlan(plan, fresh).every(result => result.changes.every(change => change.reason === 'unobserved'))).toBe(true);
    fresh.tools[0].installed = 'yes';
    fresh.tools[0].version = null;
    expect(revalidateSetupPlan(plan, fresh)[0].changes[1].reason).toBe('unobserved');
  });
});

describe('artifact-root routing', () => {
  it('honors the location pointer when env overrides are absent', async () => {
    vi.stubEnv('AIWG_ARTIFACTS_PATH', '');
    await fs.writeFile(join(project, '.aiwg-location'), '../artifacts\n');
    expect(await writeSetupPlan(project, plan)).toBe(join(root, 'setup', 'plans', `${plan.id}.json`));
    expect(await readSetupPlan(project, plan.id)).toEqual(plan);
  });

  it('uses the shared resolver default with an isolated env', async () => {
    const path = await writeSetupPlan(project, plan, {});
    expect(path).toBe(join(project, '.aiwg', 'setup', 'plans', `${plan.id}.json`));
    expect(await readSetupPlan(project, plan.id, {})).toEqual(plan);
  });

  it.each(['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR'])('honors %s', async key => {
    vi.stubEnv('AIWG_ARTIFACTS_PATH', '');
    vi.stubEnv(key, root);
    expect(await writeSetupPlan(project, plan)).toBe(join(root, 'setup', 'plans', `${plan.id}.json`));
  });

  it('refuses an unavailable external root on read/write with no fallback or root creation', async () => {
    const missing = join(scratch, 'detached', 'artifacts');
    vi.stubEnv('AIWG_ARTIFACTS_PATH', missing);
    await expect(writeSetupPlan(project, plan)).rejects.toThrow(/unavailable.*Reconnect.*will not fall back/);
    await expect(readSetupPlan(project, plan.id)).rejects.toThrow(/unavailable.*Reconnect.*no fallback/);
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(project)).toEqual([]);
  });

  it('refuses a non-directory root and rejects path traversal IDs', async () => {
    const fileRoot = join(scratch, 'file');
    await fs.writeFile(fileRoot, 'not a directory');
    vi.stubEnv('AIWG_ARTIFACTS_PATH', fileRoot);
    await expect(writeSetupPlan(project, plan)).rejects.toThrow(/unavailable/);
    for (const id of ['../escape', '/tmp/escape', 'dot.dot', '']) {
      await expect(writeSetupPlan(project, { ...plan, id })).rejects.toThrow(/plan/i);
      await expect(readSetupPlan(project, id)).rejects.toThrow(/ID/);
    }
    expect(await fs.readdir(project)).toEqual([]);
  });
});
