import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repo = path.resolve(import.meta.dirname, '../..');
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('fresh provider deployment keeps guidance on demand (#3662)', () => {
  it.each(['claude', 'codex', 'muse'])('%s has no missing-link advisories and still detects broken context links', provider => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'aiwg-rule-guidance-'));
    temporary.push(root);
    const project = path.join(root, 'project');
    const home = path.join(root, 'home');
    const bundle = path.join(project, '.aiwg/extensions/guidance-fixture');
    mkdirSync(path.join(bundle, 'rules'), { recursive: true });
    mkdirSync(home);
    writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify({
      id: 'guidance-fixture', name: 'Guidance fixture', type: 'extension', version: '1.0.0',
      description: 'Synthetic rule guidance fixture', manifestVersion: '1', platforms: { generic: 'full' },
      keywords: ['test'], deployment: { pathTemplate: '.{platform}/rules/{id}' },
    }));
    const command = 'aiwg show rule fixture-guidance --body';
    const source = `---\nname: fixture-policy\nactivation: kernel\n---\n# Fixture policy\n\nSupporting rationale: [fixture-guidance](./fixture-guidance.md) (\`${command}\`, on-demand).\n`;
    writeFileSync(path.join(bundle, 'rules/fixture-policy.md'), source);
    writeFileSync(path.join(bundle, 'rules/fixture-guidance.md'), '---\nname: fixture-guidance\nactivation: on-demand\n---\n# Synthetic guidance\n\nRead this fixture rationale.\n');
    writeFileSync(path.join(project, '.aiwg/aiwg.config'), JSON.stringify({ version: '1', providers: [provider] }));
    const env = {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, AIWG_ROOT: repo,
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_CACHE_HOME: path.join(home, '.cache'), AIWG_PROJECT_MEMORY_HOME: path.join(root, 'memory'),
      AIWG_FRAMEWORK_INDEX_CACHE: process.env.AIWG_FRAMEWORK_INDEX_CACHE,
      AIWG_FRAMEWORK_INDEX_CACHE_SOURCE: process.env.AIWG_FRAMEWORK_INDEX_CACHE_SOURCE,
      CI: '1', NO_COLOR: '1', NO_UPDATE_NOTIFIER: '1',
    };
    const cli = (...args: string[]) => {
      const result = spawnSync(process.execPath, [path.join(repo, 'bin/aiwg.mjs'), ...args], {
        cwd: project, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result.stdout;
    };
    cli('use', 'guidance-fixture', '--provider', provider, '--no-hooks', '--quiet');
    const deployed = readFileSync(path.join(project, `.${provider}/rules/fixture-policy.md`), 'utf8');
    expect(deployed).toContain(command);
    expect(deployed).not.toContain('./fixture-guidance.md');
    expect(existsSync(path.join(project, `.${provider}/rules/fixture-guidance.md`))).toBe(false);
    expect(readFileSync(path.join(bundle, 'rules/fixture-policy.md'), 'utf8')).toBe(source);
    const startup = readFileSync(path.join(project, provider === 'muse' ? 'WORKSPACE.md' : 'AIWG.md'), 'utf8');
    expect(startup).not.toContain('./fixture-guidance.md');
    expect(cli('show', 'rule', 'fixture-guidance', '--body')).toContain('Read this fixture rationale.');
    const missing = () => {
      const probe = JSON.parse(cli('status', '--probe', '--json'));
      return probe.provider_deployments.flatMap((deployment: { findings: { id: string; message: string }[] }) =>
        deployment.findings.filter(finding => finding.id === 'context-diagnostic:missing-link'));
    };
    expect(missing()).toEqual([]);
    const workspace = path.join(project, 'WORKSPACE.md');
    writeFileSync(workspace, readFileSync(workspace, 'utf8') + '\n[Broken context](./genuinely-missing.md)\n');
    expect(missing()).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'Linked context file is missing: genuinely-missing.md' }),
    ]));
  }, 180_000);
});
