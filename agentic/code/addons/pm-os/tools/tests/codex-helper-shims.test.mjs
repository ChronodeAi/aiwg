import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  adapterSlug,
  parseCliArgs,
  renderCommandAdapter,
  resolveProjectLayout
} from '../pm-os-codex-deployer.mjs';

const toolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const addonRoot = path.dirname(toolsDir);
const commandHelper = path.join(toolsDir, 'commands', 'deploy-prompts-codex.mjs');
const skillHelper = path.join(toolsDir, 'skills', 'deploy-skills-codex.mjs');

function projectRootFor(source) {
  const addons = path.dirname(source);
  const aiwg = path.dirname(addons);
  if (path.basename(source) !== 'pm-os' || path.basename(addons) !== 'addons' || path.basename(aiwg) !== '.aiwg') return null;
  return path.dirname(aiwg);
}

function fingerprint(root) {
  if (!fs.existsSync(root)) return 'missing';
  const hash = crypto.createHash('sha256');
  const rootStat = fs.lstatSync(root);
  if (rootStat.isFile()) {
    hash.update('file\0');
    hash.update(fs.readFileSync(root));
    return hash.digest('hex');
  }
  if (!rootStat.isDirectory()) {
    hash.update('non-directory');
    return hash.digest('hex');
  }
  const walk = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const filename = path.join(current, entry.name);
      hash.update(path.relative(root, filename));
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile()) hash.update(fs.readFileSync(filename));
      else hash.update('non-file');
    }
  };
  walk(root);
  return hash.digest('hex');
}

function runHelper(helper, source, ...args) {
  return spawnSync(process.execPath, [helper, '--source', source, ...args], { encoding: 'utf8' });
}

function disposableProject() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pm-os-addon-test-')));
  const source = path.join(root, '.aiwg', 'addons', 'pm-os');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.cpSync(addonRoot, source, { recursive: true });
  return { root, source };
}

function disposablePromotedProject() {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pm-os-promoted-test-')));
  const aiwgRoot = path.join(sandbox, 'aiwg');
  const source = path.join(aiwgRoot, 'agentic', 'code', 'addons', 'pm-os');
  const projectRoot = path.join(sandbox, 'project');
  fs.mkdirSync(path.join(aiwgRoot, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(aiwgRoot, 'agentic', 'code', 'frameworks'), { recursive: true });
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(aiwgRoot, 'package.json'), `${JSON.stringify({
    name: 'aiwg',
    version: 'test',
    type: 'module',
    bin: { aiwg: 'bin/aiwg.mjs' }
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(aiwgRoot, 'bin', 'aiwg.mjs'), '#!/usr/bin/env node\n');
  fs.cpSync(addonRoot, source, { recursive: true });
  return { sandbox, aiwgRoot, source, projectRoot };
}

function pythonParseNativeArtifacts(root) {
  const scripts = [
    path.join(root, '.codex', 'hooks', 'pm-os', 'session-start.py'),
    path.join(root, '.codex', 'hooks', 'pm-os', 'save-guard.py')
  ];
  const mcp = path.join(root, '.codex', 'pm-os-mcp.example.toml');
  const parser = [
    'import ast, pathlib, sys, tomllib',
    'for filename in sys.argv[1:3]: ast.parse(pathlib.Path(filename).read_text(encoding="utf-8"), filename=filename)',
    'with open(sys.argv[3], "rb") as handle: value = tomllib.load(handle)',
    'servers = value.get("mcp_servers", {})',
    'assert len(servers) == 6',
    'assert all(item.get("enabled") is False and item.get("required") is False for item in servers.values())'
  ].join('\n');
  return spawnSync('python3', ['-c', parser, ...scripts, mcp], { encoding: 'utf8' });
}

test('commands/ is the exact deterministic 26-adapter registry projection', () => {
  const commands = JSON.parse(fs.readFileSync(path.join(addonRoot, 'registry', 'commands.json'), 'utf8'));
  assert.equal(commands.length, 26);
  const names = new Set();
  for (const command of commands) {
    const name = `${adapterSlug(command)}.md`;
    names.add(name);
    assert.equal(
      fs.readFileSync(path.join(addonRoot, 'commands', name), 'utf8'),
      renderCommandAdapter(command)
    );
  }
  assert.equal(names.size, 26);
  assert.ok(names.has('pm-os-skill-browser.md'));
});

test('codex/agents is the exact manifest-derived 12-agent TOML projection', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(addonRoot, 'manifest.json'), 'utf8'));
  assert.ok(manifest.deployment.additionalFiles.includes('codex/'));
  const expected = manifest.addonConfig.agents.map((name) => `pm-os-${name}.toml`).sort();
  assert.equal(expected.length, 12);
  const directory = path.join(addonRoot, 'codex', 'agents');
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(entries.map((entry) => entry.name), expected);
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    assert.equal(entry.isFile(), true, `${filename} must be a regular file`);
    assert.equal(fs.lstatSync(filename).isSymbolicLink(), false, `${filename} must not be a symlink`);
    assert.equal(
      fs.readFileSync(filename, 'utf8').split(/\r?\n/, 1)[0],
      '# Generated by PMOS for OpenAI Codex; AIWG-managed.'
    );
  }
  const parser = [
    'import pathlib, sys, tomllib',
    'for filename in sys.argv[1:]:',
    '    with open(filename, "rb") as handle: value = tomllib.load(handle)',
    '    assert value.get("name") == pathlib.Path(filename).stem.removeprefix("pm-os-")',
    '    assert isinstance(value.get("description"), str) and value["description"].strip()',
    '    assert value.get("sandbox_mode") in {"read-only", "workspace-write"}',
    '    assert isinstance(value.get("developer_instructions"), str) and value["developer_instructions"].strip()'
  ].join('\n');
  const parsed = spawnSync('python3', ['-c', parser, ...entries.map((entry) => path.join(directory, entry.name))], {
    encoding: 'utf8'
  });
  assert.equal(parsed.status, 0, parsed.stderr);
});

test('CLI parsing preserves the project-local source and rejects unknown arguments', () => {
  assert.deepEqual(
    parseCliArgs([
      '--source', addonRoot,
      '--target', '/tmp/target',
      '--project-root', '/tmp/project',
      '--aiwg-root', '/tmp/aiwg',
      '--dry-run',
      '--mode', 'all',
      '--copy-all'
    ]),
    {
      source: addonRoot,
      target: '/tmp/target',
      projectRoot: '/tmp/project',
      aiwgRoot: '/tmp/aiwg',
      dryRun: true,
      mode: 'all',
      force: false,
      copyAll: true
    }
  );
  assert.throws(() => parseCliArgs(['--source', addonRoot, '--prune']), /unsupported argument/);
});

test('layout resolver accepts project-local and validated promoted sources but rejects arbitrary lookalikes', () => {
  const local = disposableProject();
  const promoted = disposablePromotedProject();
  try {
    const localLayout = resolveProjectLayout(local.source, { projectRoot: local.root });
    assert.equal(localLayout.sourceKind, 'project-local');
    assert.equal(localLayout.projectRoot, fs.realpathSync(local.root));

    const promotedLayout = resolveProjectLayout(promoted.source, {
      projectRoot: promoted.projectRoot,
      aiwgRoot: promoted.aiwgRoot
    });
    assert.equal(promotedLayout.sourceKind, 'promoted');
    assert.equal(promotedLayout.projectRoot, fs.realpathSync(promoted.projectRoot));
    assert.equal(promotedLayout.aiwgRoot, fs.realpathSync(promoted.aiwgRoot));

    const lookalike = path.join(promoted.sandbox, 'lookalike', 'agentic', 'code', 'addons', 'pm-os');
    fs.mkdirSync(path.dirname(lookalike), { recursive: true });
    fs.cpSync(addonRoot, lookalike, { recursive: true });
    assert.throws(
      () => resolveProjectLayout(lookalike, {
        projectRoot: promoted.projectRoot,
        aiwgRoot: promoted.aiwgRoot
      }),
      /not the PMOS addon owned by the validated AIWG root/
    );
    assert.throws(
      () => resolveProjectLayout(promoted.source, { aiwgRoot: promoted.aiwgRoot }),
      /requires --project-root/
    );

    const sourceAlias = path.join(promoted.sandbox, 'promoted-source-alias');
    fs.symlinkSync(promoted.source, sourceAlias);
    assert.throws(
      () => resolveProjectLayout(sourceAlias, {
        projectRoot: promoted.projectRoot,
        aiwgRoot: promoted.aiwgRoot
      }),
      /addon source is not a directory|without a symlink/
    );
  } finally {
    fs.rmSync(local.root, { recursive: true, force: true });
    fs.rmSync(promoted.sandbox, { recursive: true, force: true });
  }
});

test('promoted source dry run is read-only; live lifecycle deployment is idempotent', () => {
  const fixture = disposablePromotedProject();
  try {
    const skillTarget = path.join(fixture.projectRoot, '.agents', 'skills');
    const contract = ['--project-root', fixture.projectRoot, '--aiwg-root', fixture.aiwgRoot];
    const beforeDryRun = fingerprint(fixture.sandbox);

    const commandDryRun = runHelper(commandHelper, fixture.source, ...contract, '--dry-run', '--mode', 'all', '--copy-all');
    assert.equal(commandDryRun.status, 0, commandDryRun.stderr);
    assert.match(commandDryRun.stdout, /Plan fingerprint: sha256:[a-f0-9]{64}/);
    assert.match(commandDryRun.stdout, /Summary: expected=26 planned=26/);
    assert.match(commandDryRun.stdout, /hooks=2 mcp-example=1/);
    assert.match(commandDryRun.stdout, /pruned=0/);

    const skillDryRun = runHelper(
      skillHelper,
      fixture.source,
      ...contract,
      '--target', skillTarget,
      '--dry-run',
      '--mode', 'all',
      '--copy-all'
    );
    assert.equal(skillDryRun.status, 0, skillDryRun.stderr);
    assert.match(skillDryRun.stdout, /Summary: expected=1 planned=1/);
    assert.equal(fingerprint(fixture.sandbox), beforeDryRun);

    const commandDeploy = runHelper(commandHelper, fixture.source, ...contract, '--mode', 'all', '--copy-all');
    assert.equal(commandDeploy.status, 0, commandDeploy.stderr);
    const skillDeploy = runHelper(
      skillHelper,
      fixture.source,
      ...contract,
      '--target', skillTarget,
      '--mode', 'all',
      '--copy-all'
    );
    assert.equal(skillDeploy.status, 0, skillDeploy.stderr);
    assert.equal(fs.readdirSync(path.join(fixture.projectRoot, '.codex', 'commands')).length, 26);
    assert.equal(fs.readdirSync(path.join(fixture.projectRoot, '.codex', 'hooks', 'pm-os')).length, 2);
    assert.equal(
      fs.readFileSync(path.join(skillTarget, 'pm-os-quickref', '.aiwg-managed'), 'utf8'),
      'pm-os\n'
    );
    const parseResult = pythonParseNativeArtifacts(fixture.projectRoot);
    assert.equal(parseResult.status, 0, parseResult.stderr);

    const afterFirstDeploy = fingerprint(fixture.sandbox);
    const secondCommandDeploy = runHelper(commandHelper, fixture.source, ...contract, '--mode', 'all', '--copy-all');
    assert.equal(secondCommandDeploy.status, 0, secondCommandDeploy.stderr);
    assert.match(secondCommandDeploy.stdout, /changed=0/);
    assert.match(secondCommandDeploy.stdout, /lifecycle-changed=0/);
    const secondSkillDeploy = runHelper(
      skillHelper,
      fixture.source,
      ...contract,
      '--target', skillTarget,
      '--mode', 'all',
      '--copy-all'
    );
    assert.equal(secondSkillDeploy.status, 0, secondSkillDeploy.stderr);
    assert.match(secondSkillDeploy.stdout, /changed=0/);
    assert.equal(fingerprint(fixture.sandbox), afterFirstDeploy);
  } finally {
    fs.rmSync(fixture.sandbox, { recursive: true, force: true });
  }
});

test('disposable dry run is fingerprinted and read-only; live deploy preserves foreign hooks and is idempotent', () => {
  const fixture = disposableProject();
  try {
    const codexDir = path.join(fixture.root, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const foreignGroup = {
      matcher: '^compact$',
      hooks: [{ type: 'command', command: '/usr/bin/env echo foreign-hook', timeout: 3 }]
    };
    const initialHooks = {
      description: 'Foreign lifecycle configuration',
      foreignMetadata: { preserve: true },
      hooks: {
        SessionStart: [foreignGroup],
        PostToolUse: [{ matcher: '^shell$', hooks: [{ type: 'command', command: '/usr/bin/env true' }] }]
      }
    };
    fs.writeFileSync(path.join(codexDir, 'hooks.json'), `${JSON.stringify(initialHooks, null, 2)}\n`);
    const beforeDryRun = fingerprint(fixture.root);

    const commandDryRun = runHelper(commandHelper, fixture.source, '--dry-run', '--mode', 'all', '--copy-all');
    assert.equal(commandDryRun.status, 0, commandDryRun.stderr);
    assert.match(commandDryRun.stdout, /Plan fingerprint: sha256:[a-f0-9]{64}/);
    assert.match(commandDryRun.stdout, /Summary: expected=26 planned=26/);
    assert.match(commandDryRun.stdout, /hooks=2 mcp-example=1/);
    assert.match(commandDryRun.stdout, /pruned=0/);

    const skillDryRun = runHelper(skillHelper, fixture.source, '--dry-run', '--mode', 'all', '--copy-all');
    assert.equal(skillDryRun.status, 0, skillDryRun.stderr);
    assert.match(skillDryRun.stdout, /Summary: expected=1 planned=1/);
    assert.match(skillDryRun.stdout, /pruned=0 standard-skills-indexed=230/);
    assert.equal(fingerprint(fixture.root), beforeDryRun);

    const commandDeploy = runHelper(commandHelper, fixture.source, '--mode', 'all', '--copy-all');
    assert.equal(commandDeploy.status, 0, commandDeploy.stderr);
    const skillDeploy = runHelper(skillHelper, fixture.source, '--mode', 'all', '--copy-all');
    assert.equal(skillDeploy.status, 0, skillDeploy.stderr);

    const hooks = JSON.parse(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf8'));
    const resolvedFixtureRoot = fs.realpathSync(fixture.root);
    assert.equal(hooks.description, initialHooks.description);
    assert.deepEqual(hooks.foreignMetadata, initialHooks.foreignMetadata);
    assert.deepEqual(hooks.hooks.PostToolUse, initialHooks.hooks.PostToolUse);
    assert.deepEqual(hooks.hooks.SessionStart[0], foreignGroup);
    assert.equal(hooks.hooks.SessionStart.length, 2);
    assert.equal(hooks.hooks.PreToolUse.length, 1);
    assert.equal(
      hooks.hooks.SessionStart[1].hooks[0].command,
      `/usr/bin/env python3 ${path.join(resolvedFixtureRoot, '.codex', 'hooks', 'pm-os', 'session-start.py')}`
    );
    assert.equal(
      hooks.hooks.PreToolUse[0].hooks[0].command,
      `/usr/bin/env python3 ${path.join(resolvedFixtureRoot, '.codex', 'hooks', 'pm-os', 'save-guard.py')}`
    );

    const commandNames = fs.readdirSync(path.join(codexDir, 'commands'))
      .filter((name) => name.startsWith('pm-os-') && name.endsWith('.md'));
    assert.equal(commandNames.length, 26);
    assert.equal(
      fs.readFileSync(path.join(fixture.root, '.agents', 'skills', 'pm-os-quickref', '.aiwg-managed'), 'utf8'),
      'pm-os\n'
    );
    for (const name of ['session-start.py', 'save-guard.py']) {
      assert.equal(
        fs.readFileSync(path.join(codexDir, 'hooks', 'pm-os', name), 'utf8'),
        fs.readFileSync(path.join(fixture.source, 'codex', 'hooks', name), 'utf8')
      );
    }
    assert.equal(
      fs.readFileSync(path.join(codexDir, 'pm-os-mcp.example.toml'), 'utf8'),
      fs.readFileSync(path.join(fixture.source, 'codex', 'pm-os-mcp.example.toml'), 'utf8')
    );
    const parseResult = pythonParseNativeArtifacts(fixture.root);
    assert.equal(parseResult.status, 0, parseResult.stderr);

    const afterFirstDeploy = fingerprint(fixture.root);
    const secondCommandDeploy = runHelper(commandHelper, fixture.source, '--mode', 'all', '--copy-all');
    assert.equal(secondCommandDeploy.status, 0, secondCommandDeploy.stderr);
    assert.match(secondCommandDeploy.stdout, /changed=0/);
    assert.match(secondCommandDeploy.stdout, /lifecycle-changed=0/);
    const secondSkillDeploy = runHelper(skillHelper, fixture.source, '--mode', 'all', '--copy-all');
    assert.equal(secondSkillDeploy.status, 0, secondSkillDeploy.stderr);
    assert.equal(fingerprint(fixture.root), afterFirstDeploy);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('native lifecycle preflight fails closed without mutation on malformed or unowned targets', () => {
  const fixture = disposableProject();
  try {
    const codexDir = path.join(fixture.root, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'hooks.json'), '{ malformed');
    const malformedFingerprint = fingerprint(fixture.root);
    const malformed = runHelper(commandHelper, fixture.source, '--dry-run');
    assert.equal(malformed.status, 2);
    assert.match(malformed.stderr, /malformed Codex hook config/);
    assert.equal(fingerprint(fixture.root), malformedFingerprint);

    fs.writeFileSync(path.join(codexDir, 'hooks.json'), '{"hooks":{}}\n');
    fs.writeFileSync(path.join(codexDir, 'pm-os-mcp.example.toml'), '# not PMOS-owned\n');
    const collisionFingerprint = fingerprint(fixture.root);
    const collision = runHelper(commandHelper, fixture.source, '--dry-run');
    assert.equal(collision.status, 2);
    assert.match(collision.stderr, /refusing to overwrite non-PMOS Codex MCP example/);
    assert.equal(fingerprint(fixture.root), collisionFingerprint);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

const projectRoot = projectRootFor(addonRoot);
test('project-local Codex dry runs are read-only, nonzero, and prune-free', { skip: !projectRoot }, () => {
  const commandTarget = path.join(projectRoot, '.codex', 'commands');
  const skillTarget = path.join(projectRoot, '.agents', 'skills');
  const lifecycleTargets = [
    path.join(projectRoot, '.codex', 'hooks'),
    path.join(projectRoot, '.codex', 'hooks.json'),
    path.join(projectRoot, '.codex', 'pm-os-mcp.example.toml')
  ];
  const beforeCommands = fingerprint(commandTarget);
  const beforeSkills = fingerprint(skillTarget);
  const beforeLifecycle = lifecycleTargets.map(fingerprint);

  const commandResult = runHelper(commandHelper, addonRoot, '--dry-run', '--mode', 'all', '--copy-all');
  assert.equal(commandResult.status, 0, commandResult.stderr);
  assert.match(commandResult.stdout, /Plan fingerprint: sha256:[a-f0-9]{64}/);
  assert.match(commandResult.stdout, /Summary: expected=26 planned=26/);
  assert.match(commandResult.stdout, /hooks=2 mcp-example=1/);
  assert.match(commandResult.stdout, /pruned=0/);

  const skillResult = runHelper(skillHelper, addonRoot, '--target', skillTarget, '--dry-run', '--mode', 'all', '--copy-all');
  assert.equal(skillResult.status, 0, skillResult.stderr);
  assert.match(skillResult.stdout, /Summary: expected=1 planned=1/);
  assert.match(skillResult.stdout, /pruned=0 standard-skills-indexed=230/);

  assert.equal(fingerprint(commandTarget), beforeCommands);
  assert.equal(fingerprint(skillTarget), beforeSkills);
  assert.deepEqual(lifecycleTargets.map(fingerprint), beforeLifecycle);
});
