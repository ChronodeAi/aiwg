import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import test from 'node:test';

test('first-party installation guidance uses the canonical aiwg.io manifest', async () => {
  const files = [
    'README.md',
    'packages/cli/README.md',
    'docs/agentic-install-runbook.md',
    'docs/getting-started/install-connect-verify.md',
    'agentic/code/addons/aiwg-utils/skills/steward/SKILL.md',
  ];
  for (const file of files) {
    const body = await readFile(file, 'utf8');
    assert.match(body, /https:\/\/aiwg\.io\/setup\.aiwg\.yaml/);
    assert.doesNotMatch(
      body,
      /https:\/\/raw\.githubusercontent\.com\/jmagly\/aiwg\/main\/setup\.aiwg\.yaml/
    );
  }
});

test('beginner surfaces keep the interview, review, apply contract', async () => {
  const manifest = await readFile('setup.aiwg.yaml', 'utf8');
  assert.match(manifest, /choices:\n(?:\s+- .+\n)*\s+- devin\n/);
  assert.match(manifest, /aiwg use all --provider PROVIDER --json/);
  assert.doesNotMatch(manifest, /id: build-and-regenerate/);
  assert.match(manifest, /Do not make index, regenerate, status, or doctor commands mandatory/);

  const readme = await readFile('README.md', 'utf8');
  const manual = readme.slice(
    readme.indexOf('If you prefer to install manually:'),
    readme.indexOf('For the complete beginner path'),
  );
  assert.match(manual, /npm i -g aiwg\s+cd \/path\/to\/your\/project\s+aiwg setup --scope project --providers <provider>\s+aiwg setup --review\s+aiwg setup --apply/);
  assert.doesNotMatch(manual, /aiwg (?:index|regenerate|status|doctor)/);

  const cliReadme = await readFile('packages/cli/README.md', 'utf8');
  assert.match(
    cliReadme,
    /npm install --global aiwg\s+cd \/path\/to\/your\/project\s+aiwg use all --provider <provider>/,
  );

  for (const file of [
    'docs/getting-started/install-connect-verify.md',
    'docs/getting-started/new-project.md',
    'docs/getting-started/existing-project.md',
    'docs/getting-started/start-here.md',
    'docs/getting-started/just-try-it.md',
    'docs/getting-started/audit-existing-code.md',
    'docs/getting-started/team-setup.md',
    'docs/getting-started/macos-install.md',
  ]) {
    const body = await readFile(file, 'utf8');
    // Beginner guides route to one canonical setup path instead of copying CLI steps.
    const target = file === 'docs/getting-started/install-connect-verify.md'
      ? /\[manual installation reference\]\(\.\.\/cli\/install-and-repair\.md\)/
      : /\]\(install-connect-verify\.md\)/;
    assert.match(body, target, file);
    assert.doesNotMatch(body, /aiwg index build --all/, file);
  }
});

test('secure long-running-agent guidance uses the auditable site manifest', async () => {
  const files = [
    'README.md',
    'apps/cockpit/README.md',
    'docs/getting-started/install-connect-verify.md',
  ];
  for (const file of files) {
    const body = await readFile(file, 'utf8');
    assert.match(body, /https:\/\/aiwg\.io\/agentic-sandbox\/setup\.aiwg\.yaml/);
    assert.doesNotMatch(
      body,
      /https:\/\/raw\.githubusercontent\.com\/jmagly\/agentic-sandbox\/main\/setup\.aiwg\.yaml/,
    );
  }
});

const guidedDocs = [
  'README.md',
  'docs/agentic-install-runbook.md',
  'docs/getting-started/install-connect-verify.md',
  'docs/getting-started/guided-setup.md',
  'agentic/code/addons/agentic-installer/README.md',
  'agentic/code/addons/agentic-installer/agents/installer-agent.md',
  'agentic/code/addons/agentic-installer/skills/setup-run/SKILL.md',
  'agentic/code/addons/agentic-installer/skills/setup-generate/SKILL.md',
  'agentic/code/addons/agentic-installer/skills/setup-validate/SKILL.md',
  'setup.aiwg.yaml',
];

// Run after build:cli: contracts exercise the same modules shipped by the CLI.
async function guidedCli() {
  return {
    ...await import('../../dist/src/cli/handlers/setup.js'),
    ...await import('../../dist/src/cli/handlers/guided-setup.js'),
    ...await import('../../dist/src/extensions/commands/definitions.js'),
  };
}

function assertSupportedFlags(body, supported, file) {
  for (const [flag] of body.matchAll(/--[a-z][a-z0-9-]*/g)) {
    assert.ok(supported.has(flag), `${file}: documented ${flag} is absent from setup help`);
  }
}

function assertDocumentedSetupFlags(body, supported, file) {
  const commands = [...body.matchAll(/\baiwg setup(?![-\w])([^`\n]*)/g)];
  for (const [, tail] of commands) {
    assertSupportedFlags(tail, supported, file);
  }
  return commands.length;
}

test('every documented guided setup flag exists on the shipped CLI help surface', async () => {
  const { setupHandler, setupCommand } = await guidedCli();
  assert.equal(setupHandler.id, 'setup');
  assert.equal(setupCommand.id, 'setup');
  const help = (await setupHandler.help()).message;
  const supported = new Set([...help.matchAll(/--[a-z][a-z0-9-]*/g)].map(([flag]) => flag));
  for (const file of guidedDocs) {
    assert.ok(assertDocumentedSetupFlags(await readFile(file, 'utf8'), supported, file) > 0, file);
  }
  // This dedicated guide also documents standalone option names between examples.
  const reference = await readFile('docs/getting-started/guided-setup.md', 'utf8');
  const setupReference = reference.replace(/`aiwg (?!setup\b)[^`]+`/g, '');
  assertSupportedFlags(setupReference, supported, 'guided-setup.md');
  // Pin the guard itself: a newly invented documented flag must fail this contract.
  assert.throws(() => assertDocumentedSetupFlags('aiwg setup --imaginary-guided-option', supported, 'fixture'),
    /absent from setup help/);
});

test('published manifest keeps provider dispatch and orders interview before review before apply', async () => {
  const manifest = parse(await readFile('setup.aiwg.yaml', 'utf8'));
  assert.equal(manifest.metadata.execution_mode, 'provider-orchestrated');
  const steps = new Map(manifest.spec.steps.map(step => [step.id, step]));
  assert.deepEqual(steps.get('guided-interview').depends_on, ['repair-or-install']);
  assert.deepEqual(steps.get('guided-review').depends_on, ['guided-interview']);
  assert.deepEqual(steps.get('apply-guided-plan').depends_on, ['guided-review']);
  assert.deepEqual(steps.get('verify-engagement').depends_on, ['apply-guided-plan']);
  assert.match(steps.get('guided-interview').instruction, /aiwg setup --scope project\s+--providers PROVIDER/);
  assert.match(steps.get('guided-review').instruction, /aiwg setup --review/);
  assert.match(steps.get('apply-guided-plan').instruction, /aiwg setup --apply --yes --non-interactive --json/);
  assert.match(steps.get('verify-engagement').instruction, /aiwg\.setup\.apply\.v1/);
  for (const step of manifest.spec.steps) {
    assert.equal(step.type, 'agentic');
    for (const dependency of step.depends_on ?? []) assert.ok(steps.has(dependency));
  }
});

test('documented headless interview examples parse to their advertised choices', async () => {
  const { parseGuidedSetupFlags, parseSetupProjectOptions } = await guidedCli();
  const body = await readFile('docs/getting-started/guided-setup.md', 'utf8');
  const examples = [...body.matchAll(/^aiwg setup (.+)$/gm)].map(([, args]) => args.split(/\s+/));

  for (const [args, expected] of [
    [['--scope', 'user'], { scope: 'user' }],
    [['--monorepo', 'root'], { monorepo: 'root' }],
    [['--workspace', '/synthetic/a', '--workspace', '/synthetic/b'], { workspaces: ['/synthetic/a', '/synthetic/b'] }],
    [['--scan-roots', '/synthetic/extra'], { scanRoots: ['/synthetic/extra'] }],
    [['--credential', 'claude=file:/synthetic/input'], { credentials: { claude: { kind: 'credential-ref', source: 'file', name: '/synthetic/input' } } }],
    [['--credential', 'claude=stdin'], { credentials: { claude: { kind: 'credential-ref', source: 'stdin-at-apply', name: 'stdin' } } }],
    [['--jev', 'defer'], { jev: 'defer' }],
    [['--region', 'eu', '--endpoint', 'https://example.invalid', '--verify'], { jev: 'enable', jevOptions: { region: 'eu', endpoint: 'https://example.invalid', verify: true } }],
    [['--token-stdin'], { jev: 'enable', credentials: { jev: { kind: 'credential-ref', source: 'stdin-at-apply', name: 'stdin' } } }],
    [['--remove'], { jev: 'decline', jevOptions: { remove: true } }],
  ]) {
    const parsed = parseGuidedSetupFlags(args, 'setup');
    assert.equal(parsed.enabled, true);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(parsed[key], value, args.join(' '));
  }
  const context = args => ({ cwd: '/synthetic/project', frameworkRoot: process.cwd(), args, rawArgs: args });
  for (const args of examples) {
    assert.doesNotThrow(() => parseGuidedSetupFlags(args, 'setup'));
    assert.doesNotThrow(() => parseSetupProjectOptions(context(args)));
  }
  const flags = examples.find(args => args.includes('--intent'));
  assert.deepEqual(parseGuidedSetupFlags(flags, 'setup'), {
    enabled: true, scope: 'project', intent: 'code', jev: 'decline', jevOptions: undefined,
    workspaces: undefined, scanRoots: undefined, monorepo: undefined, packageRoot: undefined, credentials: {},
  });
  assert.deepEqual(parseSetupProjectOptions(context(flags)).providers, ['claude']);
  assert.equal(parseSetupProjectOptions(context(flags)).workerDispatchChoice, 'decline');
  assert.equal(parseSetupProjectOptions(context(flags)).nonInteractive, true);
  assert.equal(parseSetupProjectOptions(context(flags)).json, true);
  const applyOptions = parseSetupProjectOptions(context(examples.find(args => args.includes('--apply') && args.includes('--yes'))));
  assert.equal(applyOptions.yes, true);
  assert.equal(applyOptions.nonInteractive, true);
  assert.equal(parseSetupProjectOptions(context(['--dry-run'])).dryRun, true);
  assert.equal(parseSetupProjectOptions(context(['--target', '/synthetic/target'])).projectDir, '/synthetic/target');
  const credentials = examples.find(args => args.includes('claude=env:ANTHROPIC_API_KEY'));
  assert.deepEqual(parseGuidedSetupFlags(credentials, 'setup').credentials.claude,
    { kind: 'credential-ref', source: 'env', name: 'ANTHROPIC_API_KEY' });
  const packageArgs = examples.find(args => args.includes('--package'));
  assert.equal(parseGuidedSetupFlags(packageArgs, 'setup').packageRoot, 'packages/app');
  const jevArgs = examples.find(args => args.includes('jev=env:JEV_API_KEY'));
  assert.equal(parseGuidedSetupFlags(jevArgs, 'setup').jev, 'enable');
  const workerArgs = examples.find(args => args.includes('--worker-dispatch') && args.includes('enable'));
  assert.equal(parseSetupProjectOptions(context(workerArgs)).workerDispatchChoice, 'enable');
});

test('documented review/apply/plan/target flags dispatch through saved-plan handling', async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'aiwg-guided-doc-contract-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const project = join(scratch, 'project');
  const artifacts = join(scratch, 'artifacts');
  mkdirSync(project); mkdirSync(artifacts);
  const isolated = {
    HOME: join(scratch, 'home'), XDG_CONFIG_HOME: join(scratch, 'config'),
    AIWG_PROJECT_MEMORY_HOME: join(scratch, 'memory'), AIWG_ARTIFACTS_PATH: artifacts,
    AIWG_PROJECT_ARTIFACTS_PATH: '', AIWG_PROJECT_AIWG_DIR: '', AIWG_CONFIG_HOME: join(scratch, 'aiwg-config'),
  };
  const previous = Object.fromEntries(Object.keys(isolated).map(key => [key, process.env[key]]));
  Object.assign(process.env, isolated);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const { setupHandler } = await guidedCli();
  // An absent plan must reach the plan loader, not legacy setup or a prompt.
  for (const mode of ['--review', '--apply']) {
    const args = [mode, '--plan', 'documented-plan', '--target', project, '--yes', '--non-interactive', '--json'];
    await assert.rejects(setupHandler.execute({ cwd: project, frameworkRoot: resolve('.'), args, rawArgs: args }),
      error => error.code === 'ERR_SETUP_PLAN_NOT_FOUND' && /documented-plan/.test(error.message));
  }
  const args = ['--review', '--apply', '--non-interactive'];
  await assert.rejects(setupHandler.execute({ cwd: project, frameworkRoot: resolve('.'), args, rawArgs: args }),
    error => error.code === 'ERR_USAGE_CONFLICTING_FLAGS');
});
