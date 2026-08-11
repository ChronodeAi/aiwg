import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  isDirectProjectLocalAddonSource,
} from '../../../tools/agents/deploy-agents.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEPLOY_SCRIPT = path.join(REPO_ROOT, 'tools', 'agents', 'deploy-agents.mjs');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function sandbox(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-addon-command-migration-'));
  roots.push(root);
  return root;
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function makeBundle(root: string, overrides: Record<string, unknown> = {}): string {
  const bundle = path.join(root, 'bundle');
  write(
    path.join(bundle, 'manifest.json'),
    JSON.stringify({
      id: 'pm-os',
      type: 'addon',
      name: 'PMOS fixture',
      version: '2.6.0',
      description: 'Direct project-local addon fixture.',
      manifestVersion: '1',
      platforms: { codex: 'full' },
      keywords: ['test'],
      deployment: { pathTemplate: '.{platform}/commands/{id}.md' },
      addonConfig: { entry: { commands: 'commands/' } },
      ...overrides,
    }, null, 2) + '\n',
  );
  write(
    path.join(bundle, 'commands', 'pm-status.md'),
    '---\ndescription: Current PMOS command adapter.\n---\n\nRun PMOS status.\n',
  );
  return bundle;
}

function runDeploy(
  bundle: string,
  target: string,
  home: string,
  extra: string[] = [],
): { status: number | null; output: string } {
  const result = spawnSync(
    process.execPath,
    [
      DEPLOY_SCRIPT,
      '--source', bundle,
      '--target', target,
      '--provider', 'codex',
      '--mode', 'general',
      ...extra,
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        AIWG_ROOT: REPO_ROOT,
        HOME: home,
        USERPROFILE: home,
      },
    },
  );
  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

describe('direct project-local addon command migration guard', () => {
  it('recognizes only the strict project-local addon source shape', () => {
    const root = sandbox();
    const bundle = makeBundle(root);
    expect(isDirectProjectLocalAddonSource(bundle)).toBe(true);
    expect(isDirectProjectLocalAddonSource(REPO_ROOT)).toBe(false);

    const extension = makeBundle(path.join(root, 'extension'), { type: 'extension' });
    expect(isDirectProjectLocalAddonSource(extension)).toBe(false);

    const legacy = makeBundle(path.join(root, 'legacy'), { manifestVersion: undefined });
    expect(isDirectProjectLocalAddonSource(legacy)).toBe(false);

    const loose = path.join(root, 'loose');
    write(
      path.join(loose, 'manifest.json'),
      JSON.stringify({ id: 'pm-os', type: 'addon', manifestVersion: '1', addonConfig: {} }),
    );
    fs.mkdirSync(path.join(loose, 'commands'), { recursive: true });
    expect(isDirectProjectLocalAddonSource(loose)).toBe(false);
  });

  it('suppresses the false manual-deletion warning for an explicit skip flag', () => {
    const root = sandbox();
    const bundle = makeBundle(root);
    const target = path.join(root, 'project');
    const home = path.join(root, 'home');
    const adapter = path.join(target, '.codex', 'commands', 'pm-os-pm-status.md');
    write(adapter, '<!-- aiwg:managed vtest project-local -->\nCurrent PMOS adapter.\n');

    const result = runDeploy(bundle, target, home, ['--dry-run', '--skip-commands-migration']);

    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain('Warning: commands migration skipped');
    expect(result.output).not.toContain('Remove AIWG command files manually');
    expect(fs.existsSync(adapter)).toBe(true);
  });

  it('does not silently migrate intentional addon commands in a noninteractive live run', () => {
    const root = sandbox();
    const bundle = makeBundle(root);
    const target = path.join(root, 'project');
    const home = path.join(root, 'home');
    const adapter = path.join(target, '.codex', 'commands', 'pm-os-pm-status.md');
    const content = '<!-- aiwg:managed vtest project-local -->\nCurrent PMOS adapter.\n';
    write(adapter, content);

    const result = runDeploy(bundle, target, home);

    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain('Commands → Skills Migration');
    expect(result.output).not.toContain('Removed 1 old AIWG command');
    expect(fs.readFileSync(adapter, 'utf8')).toBe(content);
  });

  it('preserves the existing warning path for a non-addon direct source', () => {
    const root = sandbox();
    const bundle = makeBundle(root, { type: 'extension', addonConfig: undefined });
    const target = path.join(root, 'project');
    const home = path.join(root, 'home');
    write(
      path.join(target, '.codex', 'commands', 'legacy.md'),
      '<!-- aiwg:managed vtest bundled -->\nLegacy command.\n',
    );

    const result = runDeploy(bundle, target, home, ['--dry-run', '--skip-commands-migration']);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('Warning: commands migration skipped');
    expect(result.output).toContain('Remove AIWG command files manually');
  });
});
