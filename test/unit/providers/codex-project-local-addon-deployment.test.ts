/**
 * Project-local Codex addon deployment regression coverage.
 *
 * A direct addon bundle contains commands/ and skills/, but intentionally does
 * not duplicate AIWG's tools/ tree. The Codex provider must execute canonical
 * helpers from a validated AIWG_ROOT while keeping --source pointed at the
 * bundle. Cleanup must also remain scoped to that bundle in the shared
 * .agents/skills target.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PROVIDER_PATH = path.join(REPO_ROOT, 'tools', 'agents', 'providers', 'codex.mjs');

let sandbox: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-codex-addon-'));
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeSkill(bundle: string, name: string, kernel: boolean): void {
  writeFile(
    path.join(bundle, 'skills', name, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: Fixture ${name} skill for project-local Codex deployment tests.`,
      `kernel: ${kernel}`,
      'platforms: [codex]',
      '---',
      '',
      `# ${name}`,
      '',
      'Follow the fixture instructions.',
      '',
    ].join('\n'),
  );
}

function makeBundle(): string {
  const bundle = path.join(sandbox, 'fixture-addon');
  writeFile(
    path.join(bundle, 'manifest.json'),
    JSON.stringify({
      id: 'fixture-addon',
      type: 'addon',
      name: 'Fixture addon',
      version: '1.0.0',
      description: 'Direct-addon Codex deployment fixture.',
      manifestVersion: '1',
      platforms: { codex: 'full' },
      addonConfig: { entry: { commands: 'commands/', skills: 'skills/' } },
    }, null, 2) + '\n',
  );
  writeFile(
    path.join(bundle, 'commands', 'launch.md'),
    [
      '---',
      'description: Launch the project-local fixture.',
      '---',
      '',
      'Launch the fixture with $ARGUMENTS.',
      '',
    ].join('\n'),
  );
  writeSkill(bundle, 'fixture-kernel', true);
  writeSkill(bundle, 'fixture-standard', false);
  return bundle;
}

function makeUnrelatedManagedSkill(project: string): string {
  const dir = path.join(project, '.agents', 'skills', 'unrelated-aiwg-skill');
  writeFile(
    path.join(dir, 'SKILL.md'),
    '---\nname: unrelated-aiwg-skill\ndescription: Managed by another addon.\n---\nKeep me.\n',
  );
  writeFile(path.join(dir, '.aiwg-managed'), 'aiwg\n');
  return dir;
}

function snapshotTree(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const rows: string[] = [];
  function walk(current: string): void {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        rows.push(`d:${rel}`);
        walk(full);
      } else {
        rows.push(`f:${rel}:${fs.readFileSync(full).toString('base64')}`);
      }
    }
  }
  walk(root);
  return rows;
}

function runDirectAddonDeploy(
  bundle: string,
  project: string,
  home: string,
  dryRun: boolean,
  copyStandardSkills = false,
): { stdout: string; stderr: string } {
  const providerUrl = pathToFileURL(PROVIDER_PATH).href;
  const program = [
    `const provider = await import(${JSON.stringify(providerUrl)});`,
    `const opts = ${JSON.stringify({
      dryRun,
      force: false,
      mode: 'general',
      copyStandardSkills,
    })};`,
    `await provider.deployCommands(${JSON.stringify(project)}, ${JSON.stringify(bundle)}, opts);`,
    `await provider.deploySkills(${JSON.stringify(project)}, ${JSON.stringify(bundle)}, opts);`,
  ].join('\n');

  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {
      cwd: bundle,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        AIWG_ROOT: REPO_ROOT,
      },
    },
  );

  expect(
    result.status,
    `child deployment failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
  return { stdout: result.stdout, stderr: result.stderr };
}

describe('Codex project-local addon helper resolution', () => {
  it('uses only a validated AIWG root when the bundle has no helper scripts', async () => {
    const bundle = makeBundle();
    const invalidRoot = path.join(sandbox, 'not-an-aiwg-root');
    writeFile(
      path.join(invalidRoot, 'tools', 'commands', 'deploy-prompts-codex.mjs'),
      'throw new Error("must not execute");\n',
    );

    const previousRoot = process.env.AIWG_ROOT;
    const provider = await import(/* @vite-ignore */ PROVIDER_PATH);
    try {
      process.env.AIWG_ROOT = invalidRoot;
      expect(
        provider.resolveCodexDeploymentHelper(
          bundle,
          path.join('tools', 'commands', 'deploy-prompts-codex.mjs'),
        ),
      ).toBeNull();

      process.env.AIWG_ROOT = REPO_ROOT;
      expect(
        provider.resolveCodexDeploymentHelper(
          bundle,
          path.join('tools', 'commands', 'deploy-prompts-codex.mjs'),
        ),
      ).toBe(fs.realpathSync(path.join(REPO_ROOT, 'tools', 'commands', 'deploy-prompts-codex.mjs')));
    } finally {
      if (previousRoot === undefined) delete process.env.AIWG_ROOT;
      else process.env.AIWG_ROOT = previousRoot;
    }
  });

  it('fails closed instead of reporting a zero-artifact success without helpers', async () => {
    const bundle = makeBundle();
    const project = path.join(sandbox, 'project');
    const invalidRoot = path.join(sandbox, 'not-an-aiwg-root');
    fs.mkdirSync(invalidRoot, { recursive: true });

    const previousRoot = process.env.AIWG_ROOT;
    const provider = await import(/* @vite-ignore */ PROVIDER_PATH);
    try {
      process.env.AIWG_ROOT = invalidRoot;
      await expect(
        provider.deployCommands(project, bundle, { dryRun: true, mode: 'general' }),
      ).rejects.toThrow('validated AIWG_ROOT');
      await expect(
        provider.deploySkills(project, bundle, { dryRun: true, mode: 'general' }),
      ).rejects.toThrow('validated AIWG_ROOT');
    } finally {
      if (previousRoot === undefined) delete process.env.AIWG_ROOT;
      else process.env.AIWG_ROOT = previousRoot;
    }
  });

  it('passes explicit project and AIWG roots to direct-addon helpers', () => {
    const bundle = makeBundle();
    const project = path.join(sandbox, 'project');
    const home = path.join(sandbox, 'home');
    writeFile(
      path.join(bundle, 'tools', 'commands', 'deploy-prompts-codex.mjs'),
      'console.log(`command-argv:${JSON.stringify(process.argv.slice(2))}`);\n',
    );
    writeFile(
      path.join(bundle, 'tools', 'skills', 'deploy-skills-codex.mjs'),
      'console.log(`skill-argv:${JSON.stringify(process.argv.slice(2))}`);\n',
    );

    const result = runDirectAddonDeploy(bundle, project, home, true);

    expect(result.stdout).toContain(`\"--project-root\",\"${project}\"`);
    expect(result.stdout).toContain(`\"--aiwg-root\",\"${REPO_ROOT}\"`);
    expect(result.stdout).toContain(`\"--target\",\"${path.join(project, '.agents', 'skills')}\"`);
    expect(result.stdout).toContain('command-argv:');
    expect(result.stdout).toContain('skill-argv:');
  });
});

describe('Codex direct addon deployment', () => {
  it('deploys one command and the kernel skill without pruning another addon', () => {
    const bundle = makeBundle();
    const project = path.join(sandbox, 'project');
    const home = path.join(sandbox, 'home');
    const unrelated = makeUnrelatedManagedSkill(project);

    const result = runDirectAddonDeploy(bundle, project, home, false);

    expect(
      fs.existsSync(path.join(home, '.codex', 'prompts', 'aiwg-launch.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(project, '.agents', 'skills', 'fixture-kernel', 'SKILL.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(project, '.agents', 'skills', 'fixture-kernel', '.aiwg-managed')),
    ).toBe(true);

    // Standard skills stay at their source-of-truth path unless --copy-all is
    // explicit. The deploy must not mutate or remove that source directory.
    expect(fs.existsSync(path.join(bundle, 'skills', 'fixture-standard', 'SKILL.md'))).toBe(true);
    expect(
      fs.existsSync(path.join(project, '.agents', 'skills', 'fixture-standard')),
    ).toBe(false);

    // `.aiwg-managed` alone is not ownership evidence for a direct bundle;
    // another addon's deployed skill must survive this bundle's cleanup.
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(result.stdout).toContain('Summary: 1 deployed, 0 skipped');
    expect(result.stdout).not.toContain('would prune stale skill: unrelated-aiwg-skill');
  });

  it('keeps the entire fixture tree byte-for-byte unchanged in dry-run mode', () => {
    const bundle = makeBundle();
    const project = path.join(sandbox, 'project');
    const home = path.join(sandbox, 'home');
    makeUnrelatedManagedSkill(project);
    writeFile(path.join(home, 'sentinel.txt'), 'unchanged\n');
    const before = snapshotTree(sandbox);

    const result = runDirectAddonDeploy(bundle, project, home, true);

    expect(snapshotTree(sandbox)).toEqual(before);
    expect(result.stdout).toContain('[DRY RUN]');
    expect(result.stdout).toContain('[dry-run] deploy: aiwg-launch');
    expect(result.stdout).toContain('[dry-run] deploy: fixture-kernel');
  });

  it('copies the direct bundle standard skill only after explicit --copy-all opt-in', () => {
    const bundle = makeBundle();
    const project = path.join(sandbox, 'project');
    const home = path.join(sandbox, 'home');

    const result = runDirectAddonDeploy(bundle, project, home, false, true);

    expect(
      fs.existsSync(path.join(project, '.agents', 'skills', 'fixture-kernel', 'SKILL.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(project, '.agents', 'skills', 'fixture-standard', 'SKILL.md')),
    ).toBe(true);
    expect(result.stdout).toContain('fixture-addon (2 skills)');
    expect(result.stdout).toContain('Summary: 2 deployed, 0 skipped');
  });
});
