import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepareRuleDeployment, commitRuleDeploymentPlan, disposeRuleDeploymentPlan, createRuleDeploymentInputPool, disposeRuleDeploymentInputPool, deployWithRuleDelivery } from '../../../tools/agents/providers/rule-delivery.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-rule-plan-test-')); roots.push(root);
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  fs.mkdirSync(source); fs.mkdirSync(path.join(target, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(source, 'asset.md'), 'source');
  fs.writeFileSync(path.join(target, 'AGENTS.md'), 'original');
  fs.writeFileSync(path.join(target, '.cursor', 'existing'), 'original');
  const provider = { name: 'cursor', paths: { rules: '.cursor/rules' } };
  const opts = { srcRoot: source, target, mode: 'all', ruleSources: [], bindingEntries: [], deployBehaviors: false,
    pinConfigs: { project: {}, user: {} }, quiet: true };
  const deploy = async ({ target: stage }) => {
    fs.writeFileSync(path.join(stage, 'AGENTS.md'), 'updated');
    fs.writeFileSync(path.join(stage, '.cursor', 'existing'), 'updated');
  };
  return { root, source, target, provider, opts, deploy };
}

describe('staged rule deployment plans', () => {
  it('shares a leased immutable source snapshot across provider plans', async () => {
    const f = fixture(); const pool = createRuleDeploymentInputPool(f.source);
    const first = await prepareRuleDeployment({ ...f.opts, inputPool: pool }, f.provider, f.deploy);
    const second = await prepareRuleDeployment({ ...f.opts, inputPool: pool }, f.provider, f.deploy);
    disposeRuleDeploymentInputPool(pool);
    expect(first.snapshotRoot).toBe(second.snapshotRoot);
    expect(fs.existsSync(first.snapshotRoot)).toBe(true);
    disposeRuleDeploymentPlan(first);
    expect(fs.existsSync(second.snapshotRoot)).toBe(true);
    commitRuleDeploymentPlan(second);
    expect(fs.existsSync(second.snapshotRoot)).toBe(false);
    await expect(prepareRuleDeployment({ ...f.opts, inputPool: pool }, f.provider, f.deploy)).rejects.toThrow(/closed/);
  });
  it.each(['content', 'membership', 'mode', 'symlink'])('rejects shared pool %s tampering before another projection', async kind => {
    const f = fixture(); const pool = createRuleDeploymentInputPool(f.source);
    const first = await prepareRuleDeployment({ ...f.opts, inputPool: pool }, f.provider, f.deploy);
    const root = first.snapshotRoot, file = path.join(root, 'asset.md');
    expect(fs.statSync(root).mode & 0o222).toBe(0);
    expect(fs.statSync(file).mode & 0o222).toBe(0);
    disposeRuleDeploymentPlan(first);
    const rootMode = fs.statSync(root).mode & 0o7777;
    fs.chmodSync(root, rootMode | 0o200);
    if (kind === 'content') { const mode = fs.statSync(file).mode & 0o7777; fs.chmodSync(file, mode | 0o200); fs.writeFileSync(file, 'tampered'); fs.chmodSync(file, mode); }
    if (kind === 'membership') fs.writeFileSync(path.join(root, 'unexpected'), 'new');
    if (kind === 'mode') fs.chmodSync(file, (fs.statSync(file).mode & 0o7777) ^ 0o100);
    if (kind === 'symlink') { fs.unlinkSync(file); fs.symlinkSync(path.join(f.source, 'asset.md'), file); }
    fs.chmodSync(root, rootMode);
    let invoked = false;
    await expect(prepareRuleDeployment({ ...f.opts, inputPool: pool }, f.provider, async () => { invoked = true; })).rejects.toThrow(/Shared input pool changed/);
    expect(invoked).toBe(false);
    disposeRuleDeploymentInputPool(pool);
  });
  it('rejects pool mutation during projection even if live source is restored', async () => {
    const f = fixture(); const pool = createRuleDeploymentInputPool(f.source);
    const live = path.join(f.source, 'asset.md');
    await expect(prepareRuleDeployment({ ...f.opts, inputPool: pool }, f.provider, async ({ srcRoot, target }) => {
      const file = path.join(srcRoot, 'asset.md'); const mode = fs.statSync(file).mode & 0o7777;
      fs.writeFileSync(live, 'transient'); fs.chmodSync(file, mode | 0o200); fs.writeFileSync(file, 'tampered'); fs.chmodSync(file, mode);
      fs.writeFileSync(path.join(target, 'AGENTS.md'), fs.readFileSync(file)); fs.writeFileSync(live, 'source');
    })).rejects.toThrow(/Shared input pool changed/);
    expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toBe('original');
    disposeRuleDeploymentInputPool(pool);
  });
  it('rejects pool mutation between preparation and commit', async () => {
    const f = fixture(); const pool = createRuleDeploymentInputPool(f.source);
    const plan = await prepareRuleDeployment({ ...f.opts, inputPool: pool }, f.provider, f.deploy);
    const file = path.join(plan.snapshotRoot, 'asset.md'), mode = fs.statSync(file).mode & 0o7777;
    fs.chmodSync(file, mode | 0o200); fs.writeFileSync(file, 'tampered'); fs.chmodSync(file, mode);
    expect(() => commitRuleDeploymentPlan(plan)).toThrow(/Shared input pool changed/);
    expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toBe('original');
    disposeRuleDeploymentInputPool(pool);
  });
  it('rejects input drift when a shared pool is reused', async () => {
    const f = fixture(); const pool = createRuleDeploymentInputPool(f.source);
    fs.writeFileSync(path.join(f.source, 'asset.md'), 'changed');
    const plan = await prepareRuleDeployment({ ...f.opts, inputPool: pool }, f.provider, f.deploy);
    expect(() => commitRuleDeploymentPlan(plan)).toThrow(/preimage changed/);
    disposeRuleDeploymentInputPool(pool);
  });
  it('prepares without promotion, serializes, commits and disposes', async () => {
    const f = fixture(); const plan = await prepareRuleDeployment(f.opts, f.provider, f.deploy);
    expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toBe('original');
    const serialized = JSON.parse(JSON.stringify(plan));
    expect(commitRuleDeploymentPlan(serialized)).toEqual(plan.report);
    expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toBe('updated');
    expect(fs.readFileSync(path.join(f.target, '.cursor', 'existing'), 'utf8')).toBe('updated');
    expect(fs.existsSync(plan.temp)).toBe(false);
  });
  it.each(['content', 'membership', 'mode', 'symlink', 'source', 'config'])('rejects %s drift before any promotion', async change => {
    const f = fixture(); const plan = await prepareRuleDeployment(f.opts, f.provider, f.deploy);
    const file = path.join(f.target, '.cursor', 'existing');
    if (change === 'content') fs.writeFileSync(file, 'operator edit');
    if (change === 'membership') fs.writeFileSync(path.join(f.target, '.cursor', 'new'), 'operator edit');
    if (change === 'mode') fs.chmodSync(file, 0o600);
    if (change === 'symlink') { fs.rmSync(file); fs.symlinkSync('somewhere', file); }
    if (change === 'source') fs.writeFileSync(path.join(f.source, 'asset.md'), 'new source');
    if (change === 'config') { fs.mkdirSync(path.join(f.target, '.aiwg')); fs.writeFileSync(path.join(f.target, '.aiwg', 'aiwg.config'), '{}'); }
    expect(() => commitRuleDeploymentPlan(plan)).toThrow(/preimage changed|root or ancestor changed|Staged provider output changed/);
    expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toBe('original');
    expect(fs.existsSync(plan.temp)).toBe(false);
  });
  it('rejects a tampered serialized plan before writing and disposes its stage', async () => {
    const f = fixture(); const plan = await prepareRuleDeployment(f.opts, f.provider, f.deploy);
    const tampered = JSON.parse(JSON.stringify(plan)); tampered.mappings[0].from = f.source;
    expect(() => commitRuleDeploymentPlan(tampered)).toThrow(/modified rule deployment plan/);
    expect(fs.readFileSync(path.join(f.source, 'asset.md'), 'utf8')).toBe('source');
    expect(fs.existsSync(plan.temp)).toBe(true);
    disposeRuleDeploymentPlan(plan);
    expect(fs.existsSync(plan.temp)).toBe(false);
  });
  it('disposes failed preparation and preserves the original deployment', async () => {
    const f = fixture(); let stage;
    await expect(prepareRuleDeployment(f.opts, f.provider, async opts => { stage = opts.target; throw new Error('bad deploy'); })).rejects.toThrow('bad deploy');
    expect(fs.existsSync(stage)).toBe(false);
    expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toBe('original');
  });
  it('uses stable source bytes when the live input changes and reverts during projection', async () => {
    const f = fixture(); const asset = path.join(f.source, 'asset.md');
    const plan = await prepareRuleDeployment(f.opts, f.provider, async ({ srcRoot, target }) => {
      fs.writeFileSync(asset, 'transient');
      const consumed = fs.readFileSync(path.join(srcRoot, 'asset.md'), 'utf8');
      fs.writeFileSync(asset, 'source');
      fs.writeFileSync(path.join(target, 'AGENTS.md'), consumed);
    });
    commitRuleDeploymentPlan(plan);
    expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toBe('source');
  });
  it('uses stable project-local source bytes across transient edits', async () => {
    const f = fixture(); const local = path.join(f.target, 'local'); fs.mkdirSync(local);
    const asset = path.join(local, 'asset.md'); fs.writeFileSync(asset, 'source');
    f.opts.config = { installed: { local: { localPath: 'local', source: 'project-local' } } };
    delete f.opts.pinConfigs;
    const plan = await prepareRuleDeployment(f.opts, f.provider, async ({ pinConfigs, target }) => {
      fs.writeFileSync(asset, 'transient');
      const consumed = fs.readFileSync(path.join(pinConfigs.project.installed.local.localPath, 'asset.md'), 'utf8');
      fs.writeFileSync(asset, 'source');
      fs.writeFileSync(path.join(target, 'AGENTS.md'), consumed);
    });
    commitRuleDeploymentPlan(plan);
    expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toBe('source');
  });
  it('uses the frozen budget when live configuration changes and reverts', async () => {
    const f = fixture(); const dir = path.join(f.target, '.aiwg'); fs.mkdirSync(dir);
    const file = path.join(dir, 'aiwg.config');
    const strict = JSON.stringify({ rules: { inline_budget_tokens: 1 } });
    fs.writeFileSync(file, strict); f.opts.strict = true;
    await expect(prepareRuleDeployment(f.opts, f.provider, async ({ target }) => {
      fs.writeFileSync(file, JSON.stringify({ rules: { inline_budget_tokens: 0 } }));
      fs.writeFileSync(path.join(target, 'AGENTS.md'), '12345678');
      // Keep the live config relaxed until prepare completes its budget check.
    })).rejects.toThrow(/budget/i);
    fs.writeFileSync(file, strict);
    expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toBe('original');
  });
  it('freezes the budget environment before awaiting the projector', async () => {
    const f = fixture(); const key = 'AIWG_RULES_INLINE_BUDGET_TOKENS'; const prior = process.env[key];
    process.env[key] = '1'; f.opts.strict = true;
    try {
      await expect(prepareRuleDeployment(f.opts, f.provider, async ({ target }) => {
        process.env[key] = '0'; fs.writeFileSync(path.join(target, 'AGENTS.md'), '12345678');
      })).rejects.toThrow(/budget/i);
    } finally { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; }
  });
  it('supports a symlinked source root and detects link drift', async () => {
    const f = fixture(); const link = path.join(f.root, 'source-link'); fs.symlinkSync(f.source, link);
    f.opts.srcRoot = link;
    const plan = await prepareRuleDeployment(f.opts, f.provider, f.deploy);
    fs.unlinkSync(link); fs.symlinkSync(f.target, link);
    expect(() => commitRuleDeploymentPlan(plan)).toThrow(/preimage changed|ancestor changed/);
    fs.unlinkSync(link); fs.symlinkSync(f.source, link);
    await deployWithRuleDelivery(f.opts, f.provider, f.deploy);
    expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toBe('updated');
  });
  it('supports symlinked project configuration', async () => {
    const f = fixture(); const dir = path.join(f.target, '.aiwg'); fs.mkdirSync(dir);
    const file = path.join(f.root, 'config.json'); fs.writeFileSync(file, '{}');
    fs.symlinkSync(file, path.join(dir, 'aiwg.config'));
    await deployWithRuleDelivery(f.opts, f.provider, f.deploy);
    expect(fs.lstatSync(path.join(dir, 'aiwg.config')).isSymbolicLink()).toBe(true);
  });
  it('supports symlinked project-local source input', async () => {
    const f = fixture(); const local = path.join(f.root, 'local-source'); fs.mkdirSync(local);
    fs.writeFileSync(path.join(local, 'asset.md'), 'linked source');
    fs.symlinkSync(local, path.join(f.target, 'local'));
    f.opts.config = { installed: { local: { localPath: 'local', source: 'project-local' } } };
    delete f.opts.pinConfigs;
    await deployWithRuleDelivery(f.opts, f.provider, async ({ pinConfigs, target }) => {
      fs.writeFileSync(path.join(target, 'AGENTS.md'), fs.readFileSync(path.join(pinConfigs.project.installed.local.localPath, 'asset.md')));
    });
    expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toBe('linked source');
    expect(fs.lstatSync(path.join(f.target, 'local')).isSymbolicLink()).toBe(true);
  });
  it('supports a symlinked provider root', async () => {
    const f = fixture(); const external = path.join(f.root, 'provider');
    fs.renameSync(path.join(f.target, '.cursor'), external);
    fs.symlinkSync(external, path.join(f.target, '.cursor'));
    await deployWithRuleDelivery(f.opts, f.provider, f.deploy);
    expect(fs.lstatSync(path.join(f.target, '.cursor')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(external, 'existing'), 'utf8')).toBe('updated');
  });
  it('freezes a discovered absolute user graph binding target', async () => {
    const f = fixture(); const xdg = path.join(f.root, 'xdg');
    const index = path.join(xdg, 'aiwg', 'index', 'user'); fs.mkdirSync(index, { recursive: true });
    const external = path.join(f.root, 'user-agent.md'); fs.writeFileSync(external, 'stable');
    fs.symlinkSync('unrelated', path.join(xdg, 'aiwg', 'index', 'unrelated'));
    fs.writeFileSync(path.join(index, 'metadata.json'), JSON.stringify({ entries: {
      item: { type: 'agent', name: 'user-agent', path: external },
    } }));
    const rule = path.join(f.source, 'bound.md');
    fs.writeFileSync(rule, '---\nname: bound\nactivation: bound\nsummary: test\nbound_to:\n  agents: [user-agent]\n---\nRULE\n');
    f.opts.ruleSources = [rule]; delete f.opts.bindingEntries;
    const prior = process.env.XDG_DATA_HOME; process.env.XDG_DATA_HOME = xdg;
    try {
      const plan = await prepareRuleDeployment(f.opts, f.provider, async ({ target, ruleDelivery }) => {
        fs.writeFileSync(external, 'transient');
        const selected = ruleDelivery.targets.find(item => item.name === 'user-agent');
        fs.writeFileSync(path.join(target, 'AGENTS.md'), fs.readFileSync(selected.source));
        fs.writeFileSync(external, 'stable');
      });
      commitRuleDeploymentPlan(plan);
      expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toBe('stable');
    } finally { if (prior === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prior; }
  });
  it('uses the relocated project artifact index and binding content', async () => {
    const f = fixture(); const artifacts = path.join(f.root, 'artifacts');
    const index = path.join(artifacts, '.index', 'project'); fs.mkdirSync(index, { recursive: true });
    fs.symlinkSync('unrelated', path.join(artifacts, 'unrelated'));
    const agents = path.join(artifacts, 'agents'); fs.mkdirSync(agents);
    fs.writeFileSync(path.join(agents, 'project-agent.md'), 'project content');
    fs.writeFileSync(path.join(index, 'metadata.json'), JSON.stringify({ entries: {
      item: { type: 'agent', name: 'project-agent', path: '.aiwg/agents/project-agent.md' },
    } }));
    fs.writeFileSync(path.join(f.target, '.aiwg-location'), artifacts);
    fs.mkdirSync(path.join(f.target, '.aiwg'));
    fs.symlinkSync('unrelated', path.join(f.target, '.aiwg', 'unrelated'));
    const rule = path.join(f.source, 'bound.md');
    fs.writeFileSync(rule, '---\nname: bound\nactivation: bound\nsummary: test\nbound_to:\n  agents: [project-agent]\n---\nRULE\n');
    f.opts.ruleSources = [rule]; delete f.opts.bindingEntries;
    const plan = await prepareRuleDeployment(f.opts, f.provider, async ({ target, ruleDelivery }) => {
      const selected = ruleDelivery.targets.find(item => item.name === 'project-agent');
      fs.writeFileSync(path.join(target, 'AGENTS.md'), fs.readFileSync(selected.source));
    });
    commitRuleDeploymentPlan(plan);
    expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toBe('project content');
    expect(fs.lstatSync(path.join(artifacts, 'unrelated')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(f.target, '.aiwg', 'unrelated')).isSymbolicLink()).toBe(true);
  });
  it('preserves unrelated project artifacts and existing rules after success and failure', async () => {
    const f = fixture(); const dir = path.join(f.target, '.aiwg', 'working'); fs.mkdirSync(dir, { recursive: true });
    const artifact = path.join(dir, 'artifact.md'); fs.writeFileSync(artifact, 'unrelated artifact');
    const local = path.join(f.target, 'local-framework'); fs.mkdirSync(local);
    fs.writeFileSync(path.join(local, 'definition.md'), 'local framework');
    const rules = path.join(f.target, '.cursor', 'rules'); fs.mkdirSync(rules);
    const manifest = path.join(rules, '.aiwg-manifest.json'); fs.writeFileSync(manifest, '{}');
    await expect(prepareRuleDeployment(f.opts, f.provider, async () => { throw new Error('injected failure'); })).rejects.toThrow('injected failure');
    expect(fs.readFileSync(artifact, 'utf8')).toBe('unrelated artifact');
    expect(fs.readFileSync(manifest, 'utf8')).toBe('{}');
    await deployWithRuleDelivery(f.opts, f.provider, f.deploy);
    expect(fs.readFileSync(artifact, 'utf8')).toBe('unrelated artifact');
    expect(fs.readFileSync(path.join(local, 'definition.md'), 'utf8')).toBe('local framework');
    expect(fs.readFileSync(manifest, 'utf8')).toBe('{}');
  });
  it('rejects modified staged bytes without writing them', async () => {
    const f = fixture(); const plan = await prepareRuleDeployment(f.opts, f.provider, f.deploy);
    fs.writeFileSync(path.join(plan.stage, 'AGENTS.md'), 'malicious');
    expect(() => commitRuleDeploymentPlan(plan)).toThrow(/Staged provider output changed/);
    expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toBe('original');
    expect(fs.existsSync(plan.temp)).toBe(false);
  });
  it('does not dispose either stage when a descriptor points at another stage', async () => {
    const a = fixture(), b = fixture();
    const first = await prepareRuleDeployment(a.opts, a.provider, a.deploy);
    const second = await prepareRuleDeployment(b.opts, b.provider, b.deploy);
    const forged = { ...first, temp: second.temp };
    expect(() => commitRuleDeploymentPlan(forged)).toThrow(/modified rule deployment plan/);
    expect(fs.existsSync(first.temp)).toBe(true); expect(fs.existsSync(second.temp)).toBe(true);
    disposeRuleDeploymentPlan(first); disposeRuleDeploymentPlan(second);
    expect(fs.existsSync(first.temp)).toBe(false); expect(fs.existsSync(second.temp)).toBe(false);
  });
  it('rejects replacement of target by a symlink to an identical clone', async () => {
    const f = fixture(); const plan = await prepareRuleDeployment(f.opts, f.provider, f.deploy);
    const external = path.join(f.root, 'external'); fs.cpSync(f.target, external, { recursive: true });
    fs.renameSync(f.target, path.join(f.root, 'old-target')); fs.symlinkSync(external, f.target);
    expect(() => commitRuleDeploymentPlan(plan)).toThrow(/root or ancestor changed/);
    expect(fs.readFileSync(path.join(external, 'AGENTS.md'), 'utf8')).toBe('original');
    expect(fs.existsSync(plan.temp)).toBe(false);
  });
  it('detects changes behind an existing symlink', async () => {
    const f = fixture(); const linked = path.join(f.root, 'linked'); fs.writeFileSync(linked, 'first');
    fs.symlinkSync(linked, path.join(f.target, '.cursor', 'link'));
    const plan = await prepareRuleDeployment(f.opts, f.provider, f.deploy);
    fs.writeFileSync(linked, 'second');
    expect(() => commitRuleDeploymentPlan(plan)).toThrow(/preimage changed|root or ancestor changed|Staged provider output changed/);
    expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toBe('original');
  });
  it('keeps the existing wrapper and supports explicit plan disposal', async () => {
    const f = fixture(); const plan = await prepareRuleDeployment(f.opts, f.provider, f.deploy);
    disposeRuleDeploymentPlan(plan); expect(fs.existsSync(plan.temp)).toBe(false);
    await deployWithRuleDelivery(f.opts, f.provider, f.deploy);
    expect(fs.readFileSync(path.join(f.target, 'AGENTS.md'), 'utf8')).toBe('updated');
  });
});
