/** Exercise first-install and indexed project-local bindings through staging. */
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../../..');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-same-bundle-'));
  roots.push(root);
  const project = path.join(root, 'project');
  const bundle = path.join(project, '.aiwg/addons/bound-demo');
  const write = (file: string, content: string) => {
    const destination = path.join(bundle, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  };
  write('manifest.json', JSON.stringify({ id: 'bound-demo', type: 'addon', name: 'Bound Demo', version: '1.0.0',
    description: 'Synthetic bound rule', manifestVersion: '1', platforms: { claude: 'full' }, keywords: ['test'],
    deployment: { pathTemplate: '.aiwg/addons/bound-demo' }, addonConfig: { entry: { agents: 'agents/', rules: 'rules/' } } }));
  write('agents/a.md', '---\nname: a\ndescription: Synthetic agent\n---\n# A\n');
  write('rules/r.md', '---\nname: r\nactivation: bound\nsummary: Follow the demo policy.\nbound_to:\n  agents: [a]\n---\n# R\n');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
    AIWG_CONFIG: path.join(root, 'config/aiwg'), AIWG_ROOT: repo, AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1' };
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR',
    'AIWG_PROJECT_LOCAL_PATHS', 'AIWG_USER_REGISTRY_PATH', 'AIWG_RULE_BINDING_INDEX_CACHE']) delete env[key];
  const run = (script: string, args: string[]) => {
    const result = spawnSync(process.execPath, [path.join(repo, script), ...args], {
      cwd: project, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    });
    return { status: result.status, output: result.stdout + result.stderr, error: result.error };
  };
  const deploy = () => run('tools/agents/deploy-agents.mjs', ['--source', bundle, '--target', project,
    '--provider', 'claude', '--deploy-rules', '--deploy-skills', '--copy-all', '--skip-commands-migration', '--dry-run']);
  return { root, project, bundle, write, run, deploy };
}

for (const indexed of [false, true]) {
  const oldError = indexed ? 'Ambiguous agent binding target: a' : 'Missing agent binding target: a';
  it(`regresses #3700: ${oldError}`, () => {
    const { project, run, deploy } = fixture();
    if (indexed) {
      const index = run('bin/aiwg.mjs', ['index', 'build', '--graph', 'project']);
      expect(index.status, index.output).toBe(0);
    }
    const before = fs.readdirSync(project);
    // This is the deployment entry point used by `use`; it preserves the exact
    // diagnostic that the public preview currently reduces to a failure count.
    const result = deploy();
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain(oldError);
    const preview = run('bin/aiwg.mjs', ['use', 'bound-demo', '--provider', 'claude', '--dry-run']);
    expect(preview.status, preview.output).toBe(0);
    expect(fs.readdirSync(project)).toEqual(before);
    expect(fs.existsSync(path.join(project, '.claude'))).toBe(false);
  }, 120_000);
}

it('keeps genuinely distinct same-name entries in the deployed bundle ambiguous', () => {
  const { write, deploy } = fixture();
  write('agents/other.md', '---\nname: a\ndescription: A different source\n---\n# Other\n');
  const result = deploy();
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain('Ambiguous agent binding target: a:');
  expect(result.output).toContain('agents/a.md');
  expect(result.output).toContain('agents/other.md');
}, 120_000);
