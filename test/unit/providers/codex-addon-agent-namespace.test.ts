import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  deploy,
  deployAgents,
} from '../../../tools/agents/providers/codex.mjs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function sandbox(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-codex-addon-agents-'));
  roots.push(root);
  return root;
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function markdownAgent(name: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${name} fixture agent`,
    'model: sonnet',
    '---',
    '',
    `Operate as the ${name} fixture.`,
    '',
  ].join('\n');
}

function packagedAgent(
  name: string,
  instructions = `Operate as the ${name} packaged fixture.`,
  marker = '',
): string {
  return [
    marker,
    `name = ${JSON.stringify(name)}`,
    `description = ${JSON.stringify(`${name} packaged fixture`)}`,
    `developer_instructions = ${JSON.stringify(instructions)}`,
    'sandbox_mode = "workspace-write"',
    '',
  ].filter((line, index) => line || index !== 0).join('\n');
}

function makeAddon(root: string, id = 'pm-os'): string {
  const bundle = path.join(root, 'addon');
  write(
    path.join(bundle, 'manifest.json'),
    JSON.stringify({ id, type: 'addon' }, null, 2) + '\n',
  );
  return bundle;
}

function deployOptions(bundle: string, target: string, dryRun = false) {
  return {
    srcRoot: bundle,
    target,
    mode: 'general',
    deployCommands: false,
    deploySkills: false,
    deployRules: false,
    commandsOnly: false,
    skillsOnly: false,
    rulesOnly: false,
    dryRun,
    asAgentsMd: false,
    asPlugin: false,
    createAgentsMd: false,
    force: false,
    provider: 'codex',
    deployVersion: 'test',
    deploySource: 'project-local',
  };
}

function snapshotTree(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const rows: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const relative = path.relative(root, full);
      if (entry.isDirectory()) {
        rows.push(`d:${relative}`);
        walk(full);
      } else {
        rows.push(`f:${relative}:${fs.readFileSync(full).toString('base64')}`);
      }
    }
  };
  walk(root);
  return rows;
}

describe('Codex direct-addon agent namespace', () => {
  it('prefixes fallback Markdown destinations without changing TOML name metadata or double-prefixing', async () => {
    const root = sandbox();
    const bundle = makeAddon(root);
    const target = path.join(root, 'project');
    write(path.join(bundle, 'agents', 'context-manager.md'), markdownAgent('context-manager'));
    write(
      path.join(bundle, 'agents', 'pm-os-knowledge-librarian.md'),
      markdownAgent('knowledge-librarian'),
    );

    await deploy(deployOptions(bundle, target));

    const agentsDir = path.join(target, '.codex', 'agents');
    const tomls = fs.readdirSync(agentsDir).filter((name) => name.endsWith('.toml')).sort();
    expect(tomls).toEqual([
      'pm-os-context-manager.toml',
      'pm-os-knowledge-librarian.toml',
    ]);
    expect(fs.existsSync(path.join(agentsDir, 'context-manager.toml'))).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, 'pm-os-pm-os-knowledge-librarian.toml'))).toBe(false);
    expect(fs.readFileSync(path.join(agentsDir, 'pm-os-context-manager.toml'), 'utf8'))
      .toContain('name = "context-manager"');

    const sidecar = JSON.parse(
      fs.readFileSync(path.join(agentsDir, '.aiwg-manifest.json'), 'utf8'),
    );
    expect(sidecar.managed['pm-os-context-manager.toml'].frameworkSlug).toBe('pm-os');
  });

  it('leaves ordinary non-addon deployAgents filenames unchanged', () => {
    const root = sandbox();
    const source = path.join(root, 'reviewer.md');
    write(source, markdownAgent('reviewer'));

    deployAgents([source], root, {
      dryRun: false,
      force: false,
      provider: 'codex',
      deployVersion: 'test',
      deploySource: 'bundled',
    });

    expect(fs.existsSync(path.join(root, '.codex', 'agents', 'reviewer.toml'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.codex', 'agents', 'pm-os-reviewer.toml'))).toBe(false);
  });

  it('rejects an unsafe direct-addon manifest id before creating provider files', async () => {
    const root = sandbox();
    const bundle = makeAddon(root, 'PM_OS');
    const target = path.join(root, 'project');
    write(path.join(bundle, 'agents', 'context-manager.md'), markdownAgent('context-manager'));

    await expect(deploy(deployOptions(bundle, target))).rejects.toThrow('lowercase kebab slug');
    expect(fs.existsSync(path.join(target, '.codex'))).toBe(false);
  });

  it('keeps the target byte-for-byte unchanged during a direct-addon dry-run', async () => {
    const root = sandbox();
    const bundle = makeAddon(root);
    const target = path.join(root, 'project');
    write(path.join(bundle, 'agents', 'context-manager.md'), markdownAgent('context-manager'));
    write(path.join(target, 'sentinel.txt'), 'unchanged\n');
    const before = snapshotTree(target);

    await deploy(deployOptions(bundle, target, true));

    expect(snapshotTree(target)).toEqual(before);
  });
});

describe('Codex packaged direct-addon agents', () => {
  it('prefers validated packaged TOML and never deploys the Markdown duplicate', async () => {
    const root = sandbox();
    const bundle = makeAddon(root);
    const target = path.join(root, 'project');
    const marker = '# Generated by PMOS for OpenAI Codex; AIWG-managed.';
    const native = packagedAgent('packaged-context-manager', 'Use Codex-native PMOS policy.', marker);
    write(path.join(bundle, 'agents', 'context-manager.md'), markdownAgent('markdown-context-manager'));
    write(path.join(bundle, 'codex', 'agents', 'pm-os-context-manager.toml'), native);

    await deploy(deployOptions(bundle, target));

    const agentsDir = path.join(target, '.codex', 'agents');
    expect(fs.readFileSync(path.join(agentsDir, 'pm-os-context-manager.toml'), 'utf8')).toBe(native);
    expect(fs.existsSync(path.join(agentsDir, 'context-manager.toml'))).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, 'pm-os-pm-os-context-manager.toml'))).toBe(false);
    expect(fs.readdirSync(agentsDir).filter((name) => name.endsWith('.toml')))
      .toEqual(['pm-os-context-manager.toml']);
  });

  it.each([
    ['unnamespaced filename', 'context-manager.toml', packagedAgent('context-manager')],
    ['missing contract field', 'pm-os-context-manager.toml', 'name = "context-manager"\ndeveloper_instructions = "Do work."\n'],
  ])('rejects packaged agent with %s', async (_case, filename, content) => {
    const root = sandbox();
    const bundle = makeAddon(root);
    const target = path.join(root, 'project');
    write(path.join(bundle, 'agents', 'context-manager.md'), markdownAgent('context-manager'));
    write(path.join(bundle, 'codex', 'agents', filename), content);

    await expect(deploy(deployOptions(bundle, target))).rejects.toThrow('Packaged Codex agent');
    expect(fs.existsSync(path.join(target, '.codex'))).toBe(false);
  });

  it('rejects packaged agent symlinks even when their names and targets are otherwise valid', async () => {
    const root = sandbox();
    const bundle = makeAddon(root);
    const target = path.join(root, 'project');
    const realAgent = path.join(bundle, 'fixtures', 'agent.toml');
    write(realAgent, packagedAgent('context-manager'));
    const linkedAgent = path.join(bundle, 'codex', 'agents', 'pm-os-context-manager.toml');
    fs.mkdirSync(path.dirname(linkedAgent), { recursive: true });
    fs.symlinkSync(realAgent, linkedAgent);

    await expect(deploy(deployOptions(bundle, target))).rejects.toThrow('non-symlink');
    expect(fs.existsSync(path.join(target, '.codex'))).toBe(false);
  });

  it('refuses a differing unmanaged destination even with a lookalike marker', async () => {
    const root = sandbox();
    const bundle = makeAddon(root);
    const target = path.join(root, 'project');
    const src = path.join(bundle, 'codex', 'agents', 'pm-os-context-manager.toml');
    const dest = path.join(target, '.codex', 'agents', 'pm-os-context-manager.toml');
    const existing = '# Generated by PMOS, probably managed.\n' + packagedAgent('user-context');
    write(src, packagedAgent('context-manager'));
    write(dest, existing);

    await expect(deploy(deployOptions(bundle, target))).rejects.toThrow('unmanaged Codex agent');
    expect(fs.readFileSync(dest, 'utf8')).toBe(existing);
  });

  it('updates a differing destination owned by the same addon sidecar', async () => {
    const root = sandbox();
    const bundle = makeAddon(root);
    const target = path.join(root, 'project');
    const src = path.join(bundle, 'codex', 'agents', 'pm-os-context-manager.toml');
    write(src, packagedAgent('context-manager', 'Version one.'));
    await deploy(deployOptions(bundle, target));

    write(src, packagedAgent('context-manager', 'Version two.'));
    await deploy(deployOptions(bundle, target));

    expect(fs.readFileSync(
      path.join(target, '.codex', 'agents', 'pm-os-context-manager.toml'),
      'utf8',
    )).toContain('Version two.');
  });

  it('updates a pre-sidecar destination carrying the exact managed marker', async () => {
    const root = sandbox();
    const bundle = makeAddon(root);
    const target = path.join(root, 'project');
    const src = path.join(bundle, 'codex', 'agents', 'pm-os-context-manager.toml');
    const dest = path.join(target, '.codex', 'agents', 'pm-os-context-manager.toml');
    const marker = '# Generated by PMOS for OpenAI Codex; AIWG-managed.';
    write(src, packagedAgent('context-manager', 'Current instructions.', marker));
    write(dest, packagedAgent('context-manager', 'Old instructions.', marker));

    await deploy(deployOptions(bundle, target));

    expect(fs.readFileSync(dest, 'utf8')).toContain('Current instructions.');
  });

  it('dry-runs then performs the exact legacy-PMOS-marker migration without other byte drift', async () => {
    const root = sandbox();
    const bundle = makeAddon(root);
    const target = path.join(root, 'project');
    const src = path.join(bundle, 'codex', 'agents', 'pm-os-context-manager.toml');
    const dest = path.join(target, '.codex', 'agents', 'pm-os-context-manager.toml');
    const currentMarker = '# Generated by PMOS for OpenAI Codex; AIWG-managed.';
    const legacyMarker = '# Generated by bin/generate-codex-adapters.py; do not edit.';
    const incoming = packagedAgent('context-manager', 'Same body.', currentMarker);
    const existing = incoming.replace(currentMarker, legacyMarker);
    write(src, incoming);
    write(dest, existing);
    const before = snapshotTree(target);

    await deploy(deployOptions(bundle, target, true));
    expect(snapshotTree(target)).toEqual(before);

    await deploy(deployOptions(bundle, target));
    expect(fs.readFileSync(dest, 'utf8')).toBe(incoming);
  });

  it('rejects a legacy-PMOS-marker destination when any body byte differs', async () => {
    const root = sandbox();
    const bundle = makeAddon(root);
    const target = path.join(root, 'project');
    const src = path.join(bundle, 'codex', 'agents', 'pm-os-context-manager.toml');
    const dest = path.join(target, '.codex', 'agents', 'pm-os-context-manager.toml');
    const currentMarker = '# Generated by PMOS for OpenAI Codex; AIWG-managed.';
    const legacyMarker = '# Generated by bin/generate-codex-adapters.py; do not edit.';
    write(src, packagedAgent('context-manager', 'Current body.', currentMarker));
    write(dest, packagedAgent('context-manager', 'Drifted body.', legacyMarker));

    await expect(deploy(deployOptions(bundle, target))).rejects.toThrow('unmanaged Codex agent');
    expect(fs.readFileSync(dest, 'utf8')).toContain('Drifted body.');
  });
});
