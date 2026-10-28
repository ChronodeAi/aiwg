#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { globSync } from 'glob';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Discover real runner APIs and inline suites without executing source bodies.
function sourceRunner(file, body) {
  const source = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true);
  const imports = source.statements.filter(ts.isImportDeclaration).map(s => s.moduleSpecifier.text);
  let inline = false;
  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'vitest'
      && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) inline = true;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (inline || imports.includes('vitest')) return 'vitest';
  if (imports.includes('node:test')) return 'node';
  // Legacy synchronous Ralph harnesses rethrow assertions as one Node case.
  if (file.startsWith('tools/ralph-external/') && imports.some(v => v === 'assert' || v === 'node:assert/strict')) return 'node-file-harness';
  return 'unknown';
}

// Inspect declarations and owning lanes without executing test source bodies.
export async function inspectTestRegistration(root = repositoryRoot) {
  root = path.resolve(root);
  const { nodeFiles, releaseLaneWorkflows = {}, optInPackageTests = [] } = await import(pathToFileURL(path.join(root, 'config/test-lanes.mjs')).href);
  const configs = globSync('config/vitest*.config.js', { cwd: root }).sort();
  const lanes = [];
  for (const config of configs) {
    const { default: value } = await import(pathToFileURL(path.join(root, config)).href);
    lanes.push({ id: config, runner: 'vitest', files: new Set(globSync([...value.test.include, ...(value.test.includeSource ?? [])], { cwd: root, ignore: value.test.exclude ?? [] })), live: config.includes('live') || config.includes('uat-daemon') || config.includes('uat-fleet-sandbox') });
  }
  lanes.push({ id: 'node', runner: 'node', files: new Set(globSync(nodeFiles, { cwd: root })), live: false });
  // Exclude owned input-fixture trees, not unit suites whose SUT topic is fixtures.
  const ignored = ['**/node_modules/**', 'test/fixtures/**', 'agentic/code/frameworks/*/test/fixtures/**',
    'agentic/code/addons/*/test/fixtures/**', 'agentic/code/addons/*/templates/**'];
  const candidates = new Set(globSync([
    'test/**/*.{test,spec,uat}.{ts,tsx,js,jsx,mjs,mts,cts,cjs}',
    'agentic/code/frameworks/*/test/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,mts,cts,cjs}',
    'agentic/code/addons/*/test/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,mts,cts,cjs}',
    '{src,tools}/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,mts,cts,cjs}',
  ], { cwd: root, ignore: ignored }));
  // Filename discovery alone misses inline suites and unsuffixed runner imports.
  // App/package runners and generated plugin mirrors remain separate boundaries.
  const runners = new Map();
  for (const file of globSync(['{src,tools}/**/*.{ts,tsx,js,jsx,mjs,mts,cts,cjs}',
    'agentic/code/addons/*/**/*.{ts,tsx,js,jsx,mjs,mts,cts,cjs}'], { cwd: root, ignore: ignored })) {
    const body = fs.readFileSync(path.join(root, file), 'utf8');
    if (!/vitest|node:test/.test(body)) continue;
    const runner = sourceRunner(file, body);
    if (runner === 'unknown') continue;
    candidates.add(file);
    runners.set(file, runner);
  }
  const records = [];
  const errors = [];
  // A config file alone is not an enforced lane: expand canonical CI npm scripts
  // and require every offline config to be reachable from that workflow.
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  const workflow = parseYaml(fs.readFileSync(path.join(root, '.gitea/workflows/ci.yml'), 'utf8'));
  let reachable = Object.values(workflow.jobs ?? {}).flatMap(job => (job.steps ?? []).map(step => step.run ?? '')).join('\n');
  const seen = new Set();
  for (;;) {
    const names = [...reachable.matchAll(/npm run ([\w:-]+)/g)].map(m => m[1]).filter(name => !seen.has(name));
    if (!names.length) break;
    for (const name of names) {
      seen.add(name);
      if (!scripts[name]) errors.push(`Canonical CI references missing npm script ${name}`);
      else reachable += '\n' + scripts[name];
    }
  }
  const invokedNodePatterns = [...reachable.matchAll(/node --test ([^\n;&]+)/g)].flatMap(match => match[1].trim().split(/\s+/));
  for (const pattern of invokedNodePatterns) {
    if (!nodeFiles.includes(pattern)) errors.push(`Unclassified Node CLI argument/pattern in canonical CI: ${pattern}`);
  }
  const releaseReachable = new Map();
  for (const [config, workflowFile] of Object.entries(releaseLaneWorkflows)) {
    if (!fs.existsSync(path.join(root, workflowFile))) {
      errors.push(`Release lane workflow is missing: ${workflowFile}`);
      releaseReachable.set(config, '');
      continue;
    }
    const releaseWorkflow = parseYaml(fs.readFileSync(path.join(root, workflowFile), 'utf8'));
    let commands = Object.values(releaseWorkflow.jobs ?? {}).flatMap(job => (job.steps ?? []).map(step => step.run ?? '')).join('\n');
    const expanded = new Set();
    for (;;) {
      const names = [...commands.matchAll(/npm run ([\w:-]+)/g)].map(m => m[1]).filter(name => !expanded.has(name));
      if (!names.length) break;
      for (const name of names) {
        expanded.add(name);
        if (!scripts[name]) errors.push(`Release workflow references missing npm script ${name}`);
        else commands += '\n' + scripts[name];
      }
    }
    releaseReachable.set(config, commands);
  }
  // Workspace package test ownership (#3729): every `test`/`test:*` script in
  // apps/*/package.json must be invoked by a canonical CI job or be an
  // explicitly reasoned opt-in. A `--prefix <dir> (run )?<script>` reference in
  // the expanded CI text (direct, or via an expanded root alias body) counts.
  const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const packageByName = new Map();
  const packageTestScripts = [];
  for (const manifest of globSync('apps/*/package.json', { cwd: root })) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, manifest), 'utf8'));
    const dir = path.posix.dirname(manifest);
    const name = pkg.name ?? dir;
    const scripts = new Set(Object.keys(pkg.scripts ?? {}));
    packageByName.set(name, { dir, scripts });
    for (const script of scripts) {
      if (script !== 'test' && !script.startsWith('test:')) continue;
      packageTestScripts.push({ name, dir, script });
    }
  }
  const packageScriptOwned = (dir, script) =>
    new RegExp(`--prefix\\s+${escapeRegExp(dir)}\\s+(run\\s+)?${escapeRegExp(script)}(?![\\w:-])`).test(reachable);
  for (const { name, dir, script } of packageTestScripts) {
    const optedIn = (optInPackageTests ?? []).some(entry => entry?.package === name && entry?.script === script);
    if (!packageScriptOwned(dir, script) && !optedIn) errors.push(`Workspace package test has no invoking CI job: ${name} ${script}`);
  }
  for (const entry of optInPackageTests ?? []) {
    if (!entry?.package || !entry?.script) errors.push(`Opt-in package test entry is missing package or script: ${JSON.stringify(entry)}`);
    else if (!entry.reason?.trim()) errors.push(`Opt-in package test has no reason: ${entry.package} ${entry.script}`);
    else if (!packageByName.has(entry.package)) errors.push(`Opt-in package test references unknown package: ${entry.package} ${entry.script}`);
    else if (!packageByName.get(entry.package).scripts.has(entry.script)) errors.push(`Opt-in package test references missing script: ${entry.package} ${entry.script}`);
    else if (packageScriptOwned(packageByName.get(entry.package).dir, entry.script)) errors.push(`Opt-in package test is owned by CI; remove it: ${entry.package} ${entry.script}`);
  }
  for (const lane of lanes) {
    if (releaseReachable.has(lane.id)) {
      if (!releaseReachable.get(lane.id).includes(`--config ${lane.id}`)) errors.push(`Release lane is not reachable from its workflow: ${lane.id}`);
    } else if (lane.id === 'node') {
      for (const pattern of nodeFiles) if (!reachable.includes(pattern)) errors.push(`Node ownership pattern is absent from canonical CI: ${pattern}`);
    } else if (!lane.live && !reachable.includes(`--config ${lane.id}`)) errors.push(`Offline lane is not reachable from canonical CI: ${lane.id}`);
  }
  for (const file of [...candidates].sort()) {
    const runner = runners.get(file) ?? sourceRunner(file, fs.readFileSync(path.join(root, file), 'utf8'));
    const owners = lanes.filter(lane => lane.files.has(file));
    if (runner === 'unknown') errors.push(`${file}: unknown test API; declare an explicit owning runner`);
    if (!owners.length) errors.push(`${file}: unassigned test file`);
    // Coverage overlays predate this gate; release-only files must have exactly
    // one owner so neither default CI nor another lane repeats their full deploys.
    if (owners.length > 1 && owners.some(owner => releaseReachable.has(owner.id))) {
      errors.push(`${file}: release test has multiple owning lanes`);
    }
    for (const owner of owners) {
      if (owner.runner !== (runner === 'node-file-harness' ? 'node' : runner)) errors.push(`${file}: ${runner} handed to ${owner.runner} in ${owner.id}`);
    }
    records.push({ file, runner, lanes: owners.map(({ id, live }) => ({ id, live })) });
  }
  if (!records.length) errors.push('No candidate test files found');
  const report = { schemaVersion: 1, scope: 'Root test/, framework/addon test/, src/ and tool tests, including inline Vitest and unsuffixed runner imports. Owned input-fixture trees and addon templates excluded. Workspace package test scripts are covered by the package ownership check (CI-invoked or reasoned opt-in); generated plugin mirrors and manual harnesses require separate review.', units: 'Source files and imported APIs, not registered or executed cases', totalFiles: records.length, files: records, errors };
  return report;
}

export async function runRegistrationGate(root = repositoryRoot) {
  root = path.resolve(root);
  const report = await inspectTestRegistration(root);
  const { errors, totalFiles } = report;
  const output = path.join(root, 'test-results/test-registration.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log(`Runner ownership: ${totalFiles} source files assigned; report ${path.relative(root, output)}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runRegistrationGate();
}
