import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareProviderDeployments } from '../../../tools/agents/providers/provider-prepare-coordinator.mjs';
import { main as deployProvider } from '../../../tools/agents/deploy-agents.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const workerPath = fileURLToPath(new URL('../../fixtures/providers/provider-prepare-worker-fixture.mjs', import.meta.url));
const parityRunner = fileURLToPath(new URL('../../fixtures/providers/provider-prepare-parity-runner.mjs', import.meta.url));

function inventory(dir) {
  const result = {};
  const visit = (current, rel = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(rel, entry.name), file = path.join(current, entry.name);
      result[name] = entry.isDirectory() ? 'directory' : createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (entry.isDirectory()) visit(file, name);
    }
  };
  visit(dir); return result;
}

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-provider-coordinator-test-')); roots.push(root);
  const trace = path.join(root, 'trace');
  const committed = [];
  let stale = true;
  const transaction = {
    createPool: () => ({}),
    describePool: () => ({ version: 1 }),
    disposePool: () => {},
    adopt: plan => plan,
    disposePlan: () => {},
    commit: plan => {
      if (plan.order === 1 && stale) { stale = false; const error = new Error('stale'); error.code = 'AIWG_RULE_DEPLOYMENT_STALE'; throw error; }
      committed.push([plan.order, plan.attempt]);
      return { order: plan.order };
    },
    isStale: error => error?.code === 'AIWG_RULE_DEPLOYMENT_STALE',
  };
  return { root, trace, committed, transaction };
}

describe('provider prepare subprocess coordinator', () => {
  it('matches serial provider projection bytes and directory membership', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-provider-parity-test-')); roots.push(root);
    const source = path.join(root, 'source');
    const serial = path.join(root, 'serial');
    const concurrent = path.join(root, 'concurrent');
    fs.mkdirSync(path.join(source, 'rules'), { recursive: true });
    for (const target of [serial, concurrent]) {
      fs.mkdirSync(path.join(target, '.aiwg', 'frameworks'), { recursive: true });
      fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(target, '.aiwg', 'frameworks', 'registry.json'), '{"version":"fixture","frameworks":[]}\n');
      fs.writeFileSync(path.join(target, '.claude', 'settings.json'), '{"version":"fixture"}\n');
    }
    fs.writeFileSync(path.join(source, 'rules', 'guard.md'), '---\nname: guard\nactivation: kernel\nsummary: Guard fixture.\n---\n\nFollow the fixture.\n');
    const argsFor = (provider, target) => ['--source', source, '--target', target, '--provider', provider,
      '--rules-only', '--deploy-rules', '--quiet', '--skip-commands-migration'];
    await deployProvider(argsFor('cursor', serial));
    await deployProvider(argsFor('claude', serial));

    const session = await prepareProviderDeployments({
      srcRoot: source,
      jobs: ['cursor', 'claude'].map((provider, order) => ({ order, provider, target: concurrent, args: argsFor(provider, concurrent) })),
    });
    try { await session.commit(0); await session.commit(1); } finally { await session.dispose(); }
    expect(inventory(concurrent)).toEqual(inventory(serial));
  });

  it('matches serial Codex, Hermes and Pi project deployment including shared roots and receipts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-provider-real-parity-')); roots.push(root);
    const source = path.join(root, 'source');
    fs.mkdirSync(path.join(source, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(source, 'commands'), { recursive: true });
    fs.mkdirSync(path.join(source, 'skills', 'kernel-demo'), { recursive: true });
    fs.mkdirSync(path.join(source, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(source, 'agents', 'demo.md'), '---\nname: demo\ndescription: Demo agent\nmodel: sonnet\n---\nDemo.\n');
    fs.writeFileSync(path.join(source, 'commands', 'demo.md'), '---\ndescription: Demo command\n---\nDo demo $@.\n');
    fs.writeFileSync(path.join(source, 'skills', 'kernel-demo', 'SKILL.md'), '---\nname: kernel-demo\ndescription: Demo kernel skill\nkernel: true\n---\nDemo skill.\n');
    fs.writeFileSync(path.join(source, 'rules', 'guard.md'), '---\nname: guard\nactivation: kernel\nsummary: Guard fixture.\n---\nFollow fixture.\n');

    const scenario = path.join(root, 'scenario');
    const target = path.join(scenario, 'target');
    const home = path.join(scenario, 'home');
    let serialTarget;
    let serialHome;
    for (const mode of ['serial', 'concurrent']) {
      fs.rmSync(scenario, { recursive: true, force: true });
      fs.mkdirSync(path.join(target, '.aiwg', 'frameworks'), { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(target, '.aiwg', 'frameworks', 'registry.json'), '{"version":"fixture","frameworks":[]}\n');
      const run = spawnSync(process.execPath, ['--import', 'tsx', parityRunner, mode, source, target], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, HOME: home, HERMES_HOME: path.join(home, 'hermes'),
          XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
          AIWG_USER_REGISTRY_PATH: path.join(home, '.config', 'aiwg', 'installed.json') },
      });
      expect(run.status, run.stderr || run.stdout).toBe(0);
      if (mode === 'serial') {
        serialTarget = inventory(target);
        serialHome = inventory(home);
      }
    }
    expect(inventory(target)).toEqual(serialTarget);
    expect(inventory(home)).toEqual(serialHome);
  }, 90_000);

  it('matches default serial command migration and full Claude/Cursor projection', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-provider-migration-parity-')); roots.push(root);
    const source = path.join(root, 'source');
    const scenario = path.join(root, 'scenario');
    const target = path.join(scenario, 'target');
    const home = path.join(scenario, 'home');
    fs.mkdirSync(path.join(source, 'commands'), { recursive: true });
    fs.mkdirSync(path.join(source, 'skills', 'kernel-demo'), { recursive: true });
    fs.writeFileSync(path.join(source, 'commands', 'demo.md'), '---\ndescription: Demo command\n---\nDo demo.\n');
    fs.writeFileSync(path.join(source, 'skills', 'kernel-demo', 'SKILL.md'), '---\nname: kernel-demo\ndescription: Demo kernel skill\nkernel: true\n---\nDemo skill.\n');
    let serialTarget;
    for (const mode of ['serial', 'concurrent']) {
      fs.rmSync(scenario, { recursive: true, force: true });
      fs.mkdirSync(path.join(target, '.aiwg', 'frameworks'), { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(target, '.aiwg', 'frameworks', 'registry.json'), '{"version":"fixture","frameworks":[]}\n');
      fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(target, '.claude', 'settings.json'), '{"version":"fixture"}\n');
      for (const provider of ['claude', 'cursor']) {
        const commands = path.join(target, `.${provider}`, 'commands');
        fs.mkdirSync(commands, { recursive: true });
        fs.writeFileSync(path.join(commands, 'legacy.md'), '<!-- aiwg:managed version=old source=bundled -->\nLegacy.\n');
      }
      const run = spawnSync(process.execPath, ['--import', 'tsx', parityRunner, mode, source, target, 'claude,cursor'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
          AIWG_USER_REGISTRY_PATH: path.join(home, '.config', 'aiwg', 'installed.json') },
      });
      expect(run.status, run.stderr || run.stdout).toBe(0);
      if (mode === 'serial') serialTarget = inventory(target);
    }
    expect(inventory(target)).toEqual(serialTarget);
    expect(fs.existsSync(path.join(target, '.claude', 'commands', 'legacy.md'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.cursor', 'commands', 'legacy.md'))).toBe(false);
  }, 90_000);

  it('bounds child preparation at two and commits only in declared order', async () => {
    const h = harness();
    const session = await prepareProviderDeployments({
      srcRoot: h.root,
      jobs: [0, 1, 2].map(order => ({ order, provider: `p${order}`, target: h.root, args: [`--delay=${order === 2 ? 5 : 80}`] })),
      workerPath,
      workerEnv: { AIWG_COORDINATOR_TRACE: h.trace },
      transaction: h.transaction,
    });
    await session.commit(0);
    await session.commit(1);
    await session.commit(2);
    expect(h.committed).toEqual([[0, 0], [1, 1], [2, 0]]);
    const events = fs.readFileSync(h.trace, 'utf8').trim().split('\n').map(line => line.split(':'));
    const start2 = Number(events.find(([kind, order]) => kind === 'start' && order === '2')[2]);
    const firstEnd = Math.min(...events.filter(([kind]) => kind === 'end').map(([, , time]) => Number(time)));
    expect(start2).toBeGreaterThanOrEqual(firstEnd);
    await session.dispose();
  });

  it('does not expose a prepared plan until the responding worker has exited', async () => {
    const h = harness();
    const started = Date.now();
    const session = await prepareProviderDeployments({
      srcRoot: h.root,
      jobs: [{ order: 0, provider: 'linger', target: h.root, args: ['--linger=80'] }],
      workerPath,
      workerEnv: { AIWG_COORDINATOR_TRACE: h.trace },
      transaction: h.transaction,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    await session.dispose();
  });

  it('fails closed, terminates siblings and removes coordinator scratch', async () => {
    const h = harness();
    let scratch;
    await expect(prepareProviderDeployments({
      srcRoot: h.root,
      jobs: [
        { order: 0, provider: 'bad', target: h.root, args: ['--fail', '--delay=50'] },
        { order: 1, provider: 'slow', target: h.root, args: ['--delay=500'] },
      ],
      workerPath,
      workerEnv: { AIWG_COORDINATOR_TRACE: h.trace },
      transaction: h.transaction,
      onSessionRoot: root => { scratch = root; },
    })).rejects.toThrow(/fixture failure/);
    const events = fs.readFileSync(h.trace, 'utf8').trim().split('\n');
    expect(events.some(line => line.startsWith('term:'))).toBe(true);
    expect(events.some(line => line.startsWith('exit:'))).toBe(true);
    expect(fs.existsSync(scratch)).toBe(false);
    expect(h.committed).toEqual([]);
  });

  it('permits one stale retry and rejects a repeated stale result', async () => {
    const h = harness();
    h.transaction.commit = () => { const error = new Error('stale'); error.code = 'AIWG_RULE_DEPLOYMENT_STALE'; throw error; };
    const session = await prepareProviderDeployments({
      srcRoot: h.root,
      jobs: [{ order: 0, provider: 'p0', target: h.root, args: [] }],
      workerPath,
      workerEnv: { AIWG_COORDINATOR_TRACE: h.trace },
      transaction: h.transaction,
    });
    await expect(session.commit(0)).rejects.toMatchObject({ code: 'AIWG_RULE_DEPLOYMENT_STALE' });
    expect(fs.readFileSync(h.trace, 'utf8').match(/start:0:/g)).toHaveLength(2);
    await session.dispose();
  });
});
