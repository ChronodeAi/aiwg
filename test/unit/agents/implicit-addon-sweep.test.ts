import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeAllArtifactBasenames,
  getAddonAgentFiles,
  getAddonFiles,
  setImplicitAddonSweep,
} from '../../../tools/agents/providers/base.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const temps: string[] = [];
let savedAiwgRoot: string | undefined;

// AIWG_ROOT outranks srcRoot when AIWG's own root is resolved, so a developer
// shell that exports it would make every fixture below read the real tree.
beforeEach(() => {
  savedAiwgRoot = process.env.AIWG_ROOT;
  delete process.env.AIWG_ROOT;
});

afterEach(async () => {
  setImplicitAddonSweep(true);
  if (savedAiwgRoot === undefined) delete process.env.AIWG_ROOT;
  else process.env.AIWG_ROOT = savedAiwgRoot;
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

/** A minimal AIWG tree: the sdlc framework plus two addons, one contributing every artifact type. */
async function fixtureRoot(): Promise<string> {
  // omp refuses destinations under a symlink and os.tmpdir() is one on macOS.
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'aiwg-addon-sweep-'));
  temps.push(root);
  const write = async (rel: string, content: string) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content);
  };
  const agent = (name: string) => `---\nname: ${name}\ndescription: ${name}\ntools: [Read]\n---\nBody.\n`;
  await write('package.json', JSON.stringify({ name: 'aiwg', version: '2099.1.0' }));
  await write('agentic/code/providers/omp/aiwg-bridge.ts', '// bridge stub\n');
  await write('agentic/code/frameworks/sdlc-complete/manifest.json', JSON.stringify({ name: 'sdlc-complete' }));
  await write('agentic/code/frameworks/sdlc-complete/agents/framework-agent.md', agent('framework-agent'));
  await write('agentic/code/addons/helper/manifest.json', JSON.stringify({ id: 'helper' }));
  await write('agentic/code/addons/helper/agents/helper-agent.md', agent('helper-agent'));
  await write('agentic/code/addons/helper/commands/helper-command.md', '---\ndescription: addon command\n---\nRun.\n');
  await write('agentic/code/addons/helper/rules/helper-rule.md', '---\nenforcement: high\n---\n# Helper rule\n');
  await write(
    'agentic/code/addons/helper/skills/helper-skill/SKILL.md',
    '---\nname: helper-skill\ndescription: addon skill\n---\nSkill.\n',
  );
  await write('agentic/code/addons/other/manifest.json', JSON.stringify({ id: 'other' }));
  await write('agentic/code/addons/other/agents/other-agent.md', agent('other-agent'));
  return root;
}

const names = (files: string[]) => files.map(file => path.basename(file)).sort();

describe('implicit addon sweep', () => {
  it('collects every addon by default and none once switched off', async () => {
    const root = await fixtureRoot();
    expect(names(getAddonFiles(root).agents)).toEqual(['helper-agent.md', 'other-agent.md']);

    setImplicitAddonSweep(false);
    expect(getAddonFiles(root)).toEqual({ agents: [], commands: [], skills: [], rules: [] });
  });

  it('keeps only the named addons when given a list', async () => {
    const root = await fixtureRoot();
    setImplicitAddonSweep(['helper']);

    const files = getAddonFiles(root);
    expect(names(files.agents)).toEqual(['helper-agent.md']);
    expect(names(files.commands)).toEqual(['helper-command.md']);
    expect(names(files.rules)).toEqual(['helper-rule.md']);
    expect(names(files.skills)).toEqual(['helper-skill']);
  });

  it('never narrows what the prune treats as live source', async () => {
    const root = await fixtureRoot();
    setImplicitAddonSweep(false);

    // An explicit sweep: true still collects, which is how the prune safety set asks.
    expect(names(getAddonAgentFiles(root, [], { sweep: true }))).toEqual(['helper-agent.md', 'other-agent.md']);
    expect(computeAllArtifactBasenames(root, 'agents')).toEqual(
      new Set(['framework-agent', 'helper-agent', 'other-agent']),
    );
    expect(computeAllArtifactBasenames(root, 'commands')).toContain('helper-command');
    expect(computeAllArtifactBasenames(root, 'rules')).toContain('helper-rule');
  });
});

describe('deploy-agents addon sweep flags', () => {
  async function deployOmp(root: string, flags: string[]): Promise<string> {
    const target = await mkdtemp(path.join(await realpath(os.tmpdir()), 'aiwg-addon-sweep-target-'));
    temps.push(target);
    const { AIWG_ROOT: _ignored, ...env } = process.env;
    execFileSync('node', [
      path.join(repoRoot, 'tools/agents/deploy-agents.mjs'),
      '--source', root, '--target', target, '--mode', 'sdlc', '--provider', 'omp',
      '--deploy-commands', '--deploy-skills', '--deploy-rules', '--quiet', ...flags,
    ], { env: { ...env, HOME: target }, stdio: 'pipe', timeout: 60_000 });
    return target;
  }

  // A provider dir the run never wrote (no commands or rules to deploy) reads as empty.
  const deployed = async (target: string, dir: string) =>
    (await readdir(path.join(target, '.omp', dir)).catch(() => [] as string[]))
      .filter(name => name.endsWith('.md'))
      .sort();

  it('writes the framework and every addon by default in sdlc mode', async () => {
    const target = await deployOmp(await fixtureRoot(), []);
    expect(await deployed(target, 'agents')).toEqual(['framework-agent.md', 'helper-agent.md', 'other-agent.md']);
    expect(await deployed(target, 'prompts')).toContain('helper-command.md');
    expect(await deployed(target, 'rules')).toContain('helper-rule.md');
  });

  it('writes the framework alone with --no-addon-sweep', async () => {
    const target = await deployOmp(await fixtureRoot(), ['--no-addon-sweep']);
    expect(await deployed(target, 'agents')).toEqual(['framework-agent.md']);
    expect(await deployed(target, 'prompts')).not.toContain('helper-command.md');
    expect(await deployed(target, 'rules')).not.toContain('helper-rule.md');
  });

  it('writes the framework plus only the named addons with --sweep-addons', async () => {
    const target = await deployOmp(await fixtureRoot(), ['--sweep-addons', 'helper']);
    expect(await deployed(target, 'agents')).toEqual(['framework-agent.md', 'helper-agent.md']);
    expect(await deployed(target, 'prompts')).toContain('helper-command.md');
    expect(await deployed(target, 'rules')).toContain('helper-rule.md');
  });
});
