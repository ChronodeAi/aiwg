import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { transformAgent, transformCommand, transformRule, deployAgents, deploySkills, createAgentsMd, uninstall, deploy } from '../../../tools/agents/providers/omp.mjs';
const metadata = text => YAML.parse(text.split('---')[1]);
describe('OMP native deployment', () => {
  let root; beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-omp-'))); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  it('prevents implicit wildcard task delegation and reports unknown mappings', () => {
    const diagnostics = [];
    const text = transformAgent('research.md', '---\nname: researcher\ndescription: research\ntools: [Read, Task, Magic]\nmodel: sonnet\n---\nResearch carefully.', { diagnostics, quiet: true });
    expect(metadata(text)).toMatchObject({ tools: ['read'], spawns: [] });
    expect(metadata(text).model).toBeUndefined(); expect(diagnostics).toHaveLength(2);
    expect(text).toContain('Research carefully.');
    const spawn = metadata(transformAgent('a.md', '---\nname: lead\ndescription: lead\ntools: [Task]\nspawns: [researcher]\nmodel: openrouter/openai/gpt-4.1-mini\n---\nLead.'));
    expect(spawn.tools).toEqual(['task']); expect(spawn.spawns).toEqual(['researcher']);
  });
  it('normalizes names and rejects native reserved names even with whitespace', () => {
    expect(metadata(transformAgent('agent.md', '---\nname: " reviewer "\ndescription: reviewer\n---\nReview.')).name).toBe('reviewer');
    for (const name of [' main ', ' SUB ', '']) expect(() => transformAgent('agent.md', `---\nname: "${name}"\ndescription: reserved\n---\nWork.`)).toThrow(/OMP/);
    expect(() => transformAgent('agent.md', '---\nname: 42\ndescription: number\n---\nWork.')).toThrow('nonempty string');
  });
  it('translates prompts and conditional rules without importing foreign policy', () => {
    const prompt = transformCommand('a.md', '---\ndescription: "A: prompt"\nargument-hint: target\nallowed-tools: Bash\n---\nRead ${ARGUMENTS}, $1, and literal $HOME.', { quiet: true });
    expect(prompt).toContain('$ARGUMENTS, $1, and literal $HOME'); expect(metadata(prompt)['allowed-tools']).toBeUndefined();
    expect(metadata(transformRule('r.md', '---\npaths: ["src/**"]\nalwaysApply: false\nenforcement: critical\n---\nCheck.'))).toMatchObject({ globs: ['src/**'], alwaysApply: false });
  });
  it('is dry-run safe, idempotent and preserves operator modifications even with force', () => {
    const source = path.join(root, 'review.md'); fs.writeFileSync(source, '---\nname: review\ndescription: review\ntools: [Read]\n---\nReview.');
    const target = path.join(root, 'project');
    deployAgents([source], target, { dryRun: true }); expect(fs.existsSync(target)).toBe(false);
    expect(deployAgents([source], target)).toBe(1); expect(deployAgents([source], target)).toBe(0);
    const deployed = path.join(target, '.omp/agents/review.md'); fs.writeFileSync(deployed, 'operator');
    deployAgents([source], target, { force: true, quiet: true }); expect(fs.readFileSync(deployed, 'utf8')).toBe('operator');
    expect(JSON.parse(fs.readFileSync(path.join(target, '.omp/agents/.aiwg-manifest.json'))).managed['review.md'].transformation).toBe('omp-agents');
  });
  it('keeps standard skills lazy and copies full mode to one native level', () => {
    const skill = path.join(root, 'source/deep/skill'); fs.mkdirSync(skill, { recursive: true }); fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: skill\ndescription: standard\n---\nWork.');
    const target = path.join(root, 'project'); deploySkills([skill], target); expect(fs.existsSync(target)).toBe(false);
    deploySkills([skill], target, { copyStandardSkills: true }); expect(fs.existsSync(path.join(target, '.agents/skills/skill/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.omp/skills/skill'))).toBe(false);
    const collision = path.join(root, 'other/skill'); fs.mkdirSync(collision, { recursive: true }); fs.copyFileSync(path.join(skill, 'SKILL.md'), path.join(collision, 'SKILL.md'));
    // Lazy standard skills are never written, so a shared basename across frameworks is not a collision.
    expect(() => deploySkills([skill, collision], target, { dryRun: true })).not.toThrow();
    expect(() => deploySkills([skill, collision], target, { dryRun: true, copyStandardSkills: true })).toThrow('collision');
    const kernelA = path.join(root, 'k1/kskill'); const kernelB = path.join(root, 'k2/kskill');
    for (const dir of [kernelA, kernelB]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: kskill\ndescription: kernel\nkernel: true\n---\nWork.'); }
    expect(() => deploySkills([kernelA, kernelB], target, { dryRun: true })).toThrow('collision');
  });
  it('reconciles full-copy standard skills while preserving modified, unowned and Pi-owned files', () => {
    const skill = path.join(root, 'source/standard'); fs.mkdirSync(path.join(skill, 'references'), { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: standard\ndescription: standard\n---\nWork.');
    fs.writeFileSync(path.join(skill, 'references/modified.md'), 'original'); fs.writeFileSync(path.join(skill, 'references/pi.md'), 'Pi original');
    const target = path.join(root, 'project'); const destination = path.join(target, '.agents/skills/standard');
    deploySkills([skill], target, { copyStandardSkills: true });
    fs.writeFileSync(path.join(destination, 'operator.md'), 'operator'); fs.writeFileSync(path.join(destination, 'references/modified.md'), 'operator edit');
    const receiptPath = path.join(destination, 'references/.aiwg-manifest.json');
    const receipt = JSON.parse(fs.readFileSync(receiptPath)); receipt.managed['pi.md'].provider = 'pi'; fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    deploySkills([skill], target, { dryRun: true, quiet: true }); expect(fs.existsSync(path.join(destination, 'SKILL.md'))).toBe(true);
    deploySkills([skill], target, { quiet: true }); expect(fs.existsSync(path.join(destination, 'SKILL.md'))).toBe(false);
    expect(fs.readFileSync(path.join(destination, 'operator.md'), 'utf8')).toBe('operator');
    expect(fs.readFileSync(path.join(destination, 'references/modified.md'), 'utf8')).toBe('operator edit');
    expect(fs.readFileSync(path.join(destination, 'references/pi.md'), 'utf8')).toBe('Pi original');
    expect(() => deploySkills([skill], target, { quiet: true })).not.toThrow();
    fs.writeFileSync(path.join(skill, 'references/pi.md'), 'new OMP source'); deploySkills([skill], target, { copyStandardSkills: true, quiet: true });
    expect(fs.readFileSync(path.join(destination, 'references/pi.md'), 'utf8')).toBe('Pi original');
  });
  it('preserves symlink destinations and refuses malformed receipts before writes', () => {
    const source = path.join(root, 'review.md'); fs.writeFileSync(source, '---\nname: review\ndescription: review\n---\nWork.');
    const target = path.join(root, 'project'); const native = path.join(target, '.omp'); fs.mkdirSync(native, { recursive: true });
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(native, 'agents'));
    expect(() => deployAgents([source], target)).toThrow('symlink'); expect(fs.readdirSync(outside)).toEqual([]);
    fs.unlinkSync(path.join(native, 'agents')); fs.mkdirSync(path.join(native, 'agents'));
    const receipt = path.join(native, 'agents/.aiwg-manifest.json'); fs.writeFileSync(receipt, '{bad');
    expect(() => deployAgents([source], target)).toThrow('malformed receipt'); expect(fs.existsSync(path.join(native, 'agents/review.md'))).toBe(false);
    fs.writeFileSync(receipt, '{"managed":null}'); expect(() => deployAgents([source], target)).toThrow('malformed receipt');
    fs.unlinkSync(receipt); fs.symlinkSync(path.join(root, 'missing-receipt'), receipt);
    expect(() => deployAgents([source], target)).toThrow('symlink'); expect(fs.existsSync(path.join(root, 'missing-receipt'))).toBe(false);
  });
  it('preserves malformed or operator-modified bootstrap blocks on removal', () => {
    const native = path.join(root, '.omp'); fs.mkdirSync(native);
    const context = path.join(native, 'AGENTS.md'); const malformed = '<!-- AIWG:omp-bootstrap:start -->\noperator'; fs.writeFileSync(context, malformed);
    expect(() => createAgentsMd(root, root)).toThrow('malformed bootstrap'); expect(() => uninstall(root)).toThrow('malformed bootstrap'); expect(fs.readFileSync(context, 'utf8')).toBe(malformed);
    fs.unlinkSync(context); createAgentsMd(root, root); const edited = fs.readFileSync(context, 'utf8').replace('@../AIWG.md', 'operator override'); fs.writeFileSync(context, edited);
    uninstall(root); expect(fs.readFileSync(context, 'utf8')).toBe(edited);
  });
  it('deploys direct bundle kernel skills and respects the native task-agent override exception', async () => {
    const bundle = path.join(root, 'bundle');
    for (const name of ['first', 'second']) { const dir = path.join(bundle, 'skills', name); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\nkernel: true\n---\nWork.`); }
    const target = path.join(root, 'project'); await deploy({ srcRoot: bundle, target, mode: 'general', skillsOnly: true, quiet: true });
    for (const name of ['first', 'second']) expect(fs.existsSync(path.join(target, '.agents/skills', name, 'SKILL.md'))).toBe(true);
    const source = path.join(root, 'leaf.md'); fs.writeFileSync(source, '---\nname: leaf\ndescription: leaf\ntools: [Read]\n---\nRead.');
    deployAgents([source], target, { scope: 'user', home: root, env: { PI_CODING_AGENT_DIR: path.join(root, 'override') }, quiet: true });
    expect(fs.existsSync(path.join(root, '.omp/agent/agents/leaf.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'override/agents/leaf.md'))).toBe(false);
  });
  it('projects additional bundles together, retaining both skills and rule selections', async () => {
    const sources = ['primary', 'extension'].map(name => path.join(root, name));
    for (const [index, source] of sources.entries()) {
      const skill = path.join(source, 'skills', `kernel-${index}`);
      fs.mkdirSync(skill, { recursive: true });
      fs.mkdirSync(path.join(source, 'rules'));
      fs.writeFileSync(path.join(skill, 'SKILL.md'), `---\nname: kernel-${index}\ndescription: fixture\nkernel: true\n---\nWork.`);
      fs.writeFileSync(path.join(source, 'rules', `policy-${index}.md`), `---\nactivation: summary\nsummary: Follow bundle ${index}.\n---\nPolicy ${index}.`);
      fs.writeFileSync(path.join(source, 'rules/RULES-INDEX.md'), 'LEGACY_BUNDLE_INDEX_BODY');
    }
    const target = path.join(root, 'project'); fs.mkdirSync(target);
    await deploy({ srcRoot: sources[0], additionalSources: [sources[1]], target, mode: 'general',
      skillsOnly: true, deploySkills: true, deployRules: true, quiet: true,
      pinConfigs: { project: {}, user: {} } });
    for (const index of [0, 1]) {
      expect(fs.existsSync(path.join(target, '.agents/skills', `kernel-${index}`, 'SKILL.md'))).toBe(true);
      expect(fs.readFileSync(path.join(target, '.omp/AGENTS.md'), 'utf8')).toContain('.omp/rules/RULES-INDEX.md');
      expect(fs.readFileSync(path.join(target, '.omp/rules/RULES-INDEX.md'), 'utf8')).toContain(`Follow bundle ${index}.`);
    }
    expect(fs.readdirSync(path.join(target, '.omp/rules')).filter(name => /^RULES-INDEX.*\.md$/.test(name))).toEqual(['RULES-INDEX.md']);
    expect(fs.readFileSync(path.join(target, '.omp/rules/RULES-INDEX.md'), 'utf8')).not.toContain('LEGACY_BUNDLE_INDEX_BODY');
    const manifest = JSON.parse(fs.readFileSync(path.join(target, '.omp/rules/.aiwg-manifest.json'), 'utf8'));
    expect(manifest.ruleSources).toEqual(expect.arrayContaining(sources.map((source, index) => path.join(source, 'rules', `policy-${index}.md`))));
  });
  it('refreshes activated rules and retires only unchanged receipt-owned rules', async () => {
    const source = path.join(root, 'source');
    const rules = path.join(source, 'rules');
    fs.mkdirSync(rules, { recursive: true });
    const policy = path.join(rules, 'policy.md');
    fs.writeFileSync(policy, '---\nactivation: kernel\n---\nOriginal policy.');
    const target = path.join(root, 'project');
    const opts = { srcRoot: source, target, rulesOnly: true, deployRules: true, quiet: true,
      pinConfigs: { project: {}, user: {} } };
    await deploy(opts);
    const output = path.join(target, '.omp/rules');
    const receiptFile = path.join(output, '.aiwg-manifest.json');
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    // Prior OMP file copying used receipt ownership, not inline markers.
    const legacy = path.join(output, 'RULES-INDEX-old-bundle.md');
    fs.writeFileSync(legacy, 'Old source index.');
    receipt.managed[path.basename(legacy)] = { ...receipt.managed['policy.md'],
      hash: `sha256:${createHash('sha256').update('Old source index.').digest('hex')}` };
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    fs.writeFileSync(path.join(output, 'operator.md'), 'Keep operator rule.');
    fs.writeFileSync(policy, '---\nactivation: kernel\n---\nRevised policy.');
    await deploy(opts);
    expect(fs.readFileSync(path.join(output, 'policy.md'), 'utf8')).toContain('Revised policy.');
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(output, 'operator.md'), 'utf8')).toBe('Keep operator rule.');
    fs.writeFileSync(path.join(output, 'policy.md'), 'Operator changed the generated rule.');
    fs.unlinkSync(policy);
    await deploy(opts);
    expect(fs.readFileSync(path.join(output, 'policy.md'), 'utf8')).toBe('Operator changed the generated rule.');
    expect(JSON.parse(fs.readFileSync(receiptFile, 'utf8')).managed['policy.md'].hash)
      .not.toBe(`sha256:${createHash('sha256').update('Operator changed the generated rule.').digest('hex')}`);
  });
  it.each(['unowned rule', 'unowned index', 'edited rule'])('preserves %s on activation projection even with force', async kind => {
    const source = path.join(root, 'source');
    fs.mkdirSync(path.join(source, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(source, 'rules/policy.md'), '---\nactivation: kernel\n---\nPolicy.');
    const target = path.join(root, 'project');
    const opts = { srcRoot: source, target, rulesOnly: true, deployRules: true, quiet: true, force: true,
      pinConfigs: { project: {}, user: {} } };
    if (kind === 'edited rule') await deploy(opts);
    const output = path.join(target, '.omp/rules');
    fs.mkdirSync(output, { recursive: true });
    const file = path.join(output, kind === 'unowned index' ? 'RULES-INDEX.md' : 'policy.md');
    fs.writeFileSync(file, 'Operator rule.');
    await expect(deploy(opts)).rejects.toThrow('OMP rules collision');
    expect(fs.readFileSync(file, 'utf8')).toBe('Operator rule.');
  });
  it.each(['rule', 'receipt', 'directory'])('refuses a symlinked %s before rule staging', async kind => {
    const source = path.join(root, 'source');
    fs.mkdirSync(path.join(source, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(source, 'rules/policy.md'), '---\nactivation: kernel\n---\nPolicy.');
    const target = path.join(root, 'project');
    const native = path.join(target, '.omp');
    const output = path.join(native, 'rules');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(native, { recursive: true });
    fs.mkdirSync(outside);
    if (kind === 'directory') fs.symlinkSync(outside, output, 'dir');
    else {
      fs.mkdirSync(output);
      const backing = path.join(outside, 'operator');
      fs.writeFileSync(backing, 'Operator bytes.');
      fs.symlinkSync(backing, path.join(output, kind === 'rule' ? 'policy.md' : '.aiwg-manifest.json'));
    }
    await expect(deploy({ srcRoot: source, target, rulesOnly: true, deployRules: true, quiet: true,
      pinConfigs: { project: {}, user: {} } })).rejects.toThrow('symlink destination');
    expect(fs.readdirSync(outside)).toEqual(kind === 'directory' ? [] : ['operator']);
    if (kind !== 'directory') expect(fs.readFileSync(path.join(outside, 'operator'), 'utf8')).toBe('Operator bytes.');
  });
  it.each([
    ['.omp', 'dir'],
    ['.omp/agents', 'dir'],
    ['.omp/prompts', 'dir'],
    ['.omp/extensions', 'dir'],
    ['.agents/skills', 'dir'],
    ['.omp/agents/review.md', 'file'],
    ['.agents/skills/kernel/SKILL.md', 'file'],
    ['.omp/AGENTS.md', 'file'],
    ['.omp/RULES-BOUND.md', 'file'],
    ['.omp/.aiwg-manifest.json', 'file'],
  ])('refuses the original %s link before promoting any OMP output', async (relative, type) => {
    const corpus = path.join(root, 'source');
    const source = path.join(corpus, 'agentic/code/frameworks/fixture');
    for (const directory of ['agents', 'commands', 'skills/kernel', 'rules']) {
      fs.mkdirSync(path.join(source, directory), { recursive: true });
    }
    fs.writeFileSync(path.join(source, 'agents/review.md'), '---\nname: review\ndescription: review\n---\nReview.');
    fs.writeFileSync(path.join(source, 'commands/review.md'), '---\ndescription: review\n---\nReview.');
    fs.writeFileSync(path.join(source, 'skills/kernel/SKILL.md'), '---\nname: kernel\ndescription: kernel\nkernel: true\n---\nWork.');
    fs.writeFileSync(path.join(source, 'rules/policy.md'), '---\nactivation: kernel\n---\nPolicy.');
    fs.mkdirSync(path.join(corpus, 'agentic/code/providers/omp'), { recursive: true });
    fs.mkdirSync(path.join(corpus, 'agentic/code/addons'), { recursive: true });
    fs.writeFileSync(path.join(corpus, 'package.json'), '{"name":"aiwg","version":"2026.10.16"}');
    fs.writeFileSync(path.join(source, 'package.json'), '{"name":"fixture","version":"2026.10.16"}');
    fs.writeFileSync(path.join(corpus, 'agentic/code/providers/omp/aiwg-bridge.ts'), 'export const fixtureBridge = true;\n');
    const target = path.join(root, 'project');
    const destination = path.join(target, relative);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.mkdirSync(outside);
    const backing = path.join(outside, 'operator');
    fs.writeFileSync(backing, '{"managed":{}}');
    if (relative === '.agents/skills/kernel/SKILL.md') {
      fs.writeFileSync(path.join(path.dirname(destination), '.aiwg-manifest.json'), JSON.stringify({
        managed: { 'SKILL.md': { provider: 'omp', transformation: 'omp-skill',
          hash: `sha256:${createHash('sha256').update('{"managed":{}}').digest('hex')}` } },
      }));
    }
    fs.symlinkSync(type === 'dir' ? outside : backing, destination, type);
    await expect(deploy({ srcRoot: source, target, deployCommands: true, deploySkills: true, quiet: true,
      pinConfigs: { project: {}, user: {} } })).rejects.toThrow('symlink destination');
    expect(fs.readdirSync(outside)).toEqual(['operator']);
    expect(fs.readFileSync(backing, 'utf8')).toBe('{"managed":{}}');
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true);
  });
  it('preserves an unrelated linked operator skill while deploying a selected kernel skill', async () => {
    const source = path.join(root, 'source');
    fs.mkdirSync(path.join(source, 'skills/kernel'), { recursive: true });
    fs.writeFileSync(path.join(source, 'skills/kernel/SKILL.md'), '---\nname: kernel\ndescription: kernel\nkernel: true\n---\nKernel work.');
    const target = path.join(root, 'project');
    const skills = path.join(target, '.agents/skills');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(skills, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'SKILL.md'), 'Operator skill.');
    fs.symlinkSync(outside, path.join(skills, 'operator'), 'dir');
    await deploy({ srcRoot: source, target, skillsOnly: true, quiet: true });
    expect(fs.readFileSync(path.join(skills, 'kernel/SKILL.md'), 'utf8')).toContain('Kernel work.');
    expect(fs.lstatSync(path.join(skills, 'operator')).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(outside)).toEqual(['SKILL.md']);
    expect(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8')).toBe('Operator skill.');
  });
  it('refuses lazy standard-skill cleanup through a linked owned skill directory', async () => {
    const source = path.join(root, 'source');
    const skill = path.join(source, 'skills/standard');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: standard\ndescription: standard\n---\nStandard work.');
    const target = path.join(root, 'project');
    deploySkills([skill], target, { copyStandardSkills: true });
    const destination = path.join(target, '.agents/skills/standard');
    const outside = path.join(root, 'outside');
    fs.renameSync(destination, outside);
    fs.symlinkSync(outside, destination, 'dir');
    const before = fs.readdirSync(outside).map(name => [name, fs.readFileSync(path.join(outside, name), 'utf8')]);
    await expect(deploy({ srcRoot: source, target, skillsOnly: true, quiet: true }))
      .rejects.toThrow('symlink destination');
    expect(fs.readdirSync(outside).map(name => [name, fs.readFileSync(path.join(outside, name), 'utf8')])).toEqual(before);
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(target, '.aiwg'))).toBe(false);
  });
  it('rejects colliding activated rule basenames before promoting any output', async () => {
    const sources = ['first', 'second'].map(name => path.join(root, name));
    for (const [index, source] of sources.entries()) {
      fs.mkdirSync(path.join(source, 'rules'), { recursive: true });
      fs.writeFileSync(path.join(source, 'rules/policy.md'), `---\nactivation: kernel\n---\nPolicy ${index}.`);
    }
    const target = path.join(root, 'project');
    await expect(deploy({ srcRoot: sources[0], additionalSources: [sources[1]], target,
      rulesOnly: true, deployRules: true, quiet: true, pinConfigs: { project: {}, user: {} } }))
      .rejects.toThrow('OMP rules collision');
    expect(fs.existsSync(path.join(target, '.omp/rules/policy.md'))).toBe(false);
  });
  it('preserves shell-looking prompt text and reports unsupported metadata without evaluation', () => {
    const diagnostics = [];
    const prompt = transformCommand('literal.md', '---\ndescription: literal\nunknown-metadata: value\n---\n`uname` $(whoami) $HOME $$ ${1} $ARGUMENTS', { quiet: true, diagnostics });
    expect(prompt).toContain('`uname` $(whoami) $HOME $$ $1 $ARGUMENTS'); expect(diagnostics).toEqual(['prompt literal.md: metadata unknown-metadata omitted']);
    expect(prompt).not.toContain('unknown-metadata:');
  });
  it('uses the resolved profile and uninstalls only unchanged owned files', () => {
    const source = path.join(root, 'review.md'); fs.writeFileSync(source, '---\nname: review\ndescription: review\n---\nReview.');
    const opts = { scope: 'user', env: { OMP_PROFILE: 'testing' }, home: root, quiet: true };
    deployAgents([source], root, opts);
    const agents = path.join(root, '.omp/profiles/testing/agent/agents');
    expect(fs.existsSync(path.join(agents, 'review.md'))).toBe(true);
    fs.writeFileSync(path.join(agents, 'operator.md'), 'mine');
    expect(uninstall(root, { ...opts, dryRun: true })).toBe(1);
    expect(fs.existsSync(path.join(agents, 'review.md'))).toBe(true);
    expect(uninstall(root, opts)).toBe(1);
    expect(fs.readFileSync(path.join(agents, 'operator.md'), 'utf8')).toBe('mine');
  });
  it('preserves context operators and leaves shared bootstraps untouched', () => {
    fs.mkdirSync(path.join(root, '.omp')); fs.writeFileSync(path.join(root, '.omp/AGENTS.md'), 'Operator notes.\n'); fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Shared');
    createAgentsMd(root, root); const once = fs.readFileSync(path.join(root, '.omp/AGENTS.md'), 'utf8'); createAgentsMd(root, root);
    expect(fs.readFileSync(path.join(root, '.omp/AGENTS.md'), 'utf8')).toBe(once); expect(once).toContain('@../WORKSPACE.md'); expect(once).toContain('Operator notes.'); expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toBe('Shared');
  });
});

it('public remove omp route preserves operator files and supports dry-run', async () => {
  const { removeHandler } = await import('../../../src/cli/handlers/subcommands.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-omp-remove-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-omp-remove-config-'));
  vi.stubEnv('AIWG_CONFIG', configDir);
  try {
    const source = path.join(root, 'agent.md'); fs.writeFileSync(source, '---\nname: agent\ndescription: agent\n---\nWork.');
    deployAgents([source], root);
    const deployed = path.join(root, '.omp/agents/agent.md');
    const operator = path.join(root, '.omp/agents/operator.md'); fs.writeFileSync(operator, 'operator');
    let result = await removeHandler.execute({ args: ['omp', '--provider', 'omp', '--dry-run'], cwd: root });
    expect(result.exitCode).toBe(0); expect(fs.existsSync(deployed)).toBe(true);
    result = await removeHandler.execute({ args: ['omp', '--provider', 'omp'], cwd: root });
    expect(result.exitCode).toBe(0); expect(fs.existsSync(deployed)).toBe(false); expect(fs.readFileSync(operator, 'utf8')).toBe('operator');
  } finally { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(configDir, { recursive: true, force: true }); }
});
