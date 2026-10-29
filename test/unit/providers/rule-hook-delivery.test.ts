// Minimal hooks must reach complete per-harness contracts and survive redeployment.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileWithCapture as execFileSync } from '../../helpers/exec-file-capture.js';
import { readRuleDeliveryContext } from '../../helpers/rule-delivery-context.js';
import { generate } from '../../../src/smiths/context-pipeline/index.js';

const repo = path.resolve(__dirname, '../../..');
const roots: string[] = [];
const read = (file: string) => fs.readFileSync(file, 'utf8');
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-rule-hooks-')); roots.push(root);
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  fs.cpSync(path.join(repo, 'test/fixtures/rule-delivery'), source, { recursive: true });
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'rules/core-policy.md'), '---\nactivation: core\n---\nFull policy.');
  fs.writeFileSync(path.join(source, 'rules/core-policy.core.md'), 'CORE_POLICY');
  return { root, source, target };
}
function deploy(root: string, provider: string) {
  let source = path.join(root, 'source');
  const target = path.join(root, 'target');
  if (provider === 'omp') {
    const corpus = path.join(root, 'omp-corpus');
    const bridge = path.join(corpus, 'agentic/code/providers/omp/aiwg-bridge.ts');
    fs.mkdirSync(path.dirname(bridge), { recursive: true });
    fs.mkdirSync(path.join(corpus, 'agentic/code/frameworks'), { recursive: true });
    const bundle = path.join(corpus, 'agentic/code/addons/fixture');
    if (!fs.existsSync(bundle)) fs.cpSync(source, bundle, { recursive: true });
    fs.writeFileSync(bridge, '// Synthetic local extension.\nexport default function () {}\n');
    source = bundle;
  }
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { deploy } = await import(${JSON.stringify(path.join(repo, 'tools/agents/providers'))} + '/' + ${JSON.stringify(provider)} + '.mjs');
    const report = await deploy(${JSON.stringify({ srcRoot: source, target, mode: 'all', kernelOnly: true, deployRules: true, quiet: true, ruleSources: fs.readdirSync(path.join(source, 'rules')).filter(file => !file.endsWith('.core.md')).map(file => path.join(source, 'rules', file)) })});
    console.log('REPORT:' + JSON.stringify(report));
  `], { cwd: repo, encoding: 'utf8', timeout: 60_000, stdio: 'pipe', env: {
    PATH: process.env.PATH, HOME: path.join(root, 'home'), HERMES_HOME: path.join(root, 'home/.hermes'),
    AIWG_ROOT: source, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    AIWG_RULES_INLINE_BUDGET_TOKENS: '0', CI: '1',
  } });
  return JSON.parse(stdout.split('REPORT:')[1].trim());
}

describe('per-harness rule hooks (#3740)', () => {
  it.each(['codex', 'muse', 'factory', 'antigravity', 'pi', 'copilot', 'omp', 'warp', 'hermes', 'grok-build', 'windsurf', 'opencode'])('%s reaches complete kernel files and indexes through its hook', provider => {
    const { root, target } = setup();
    const report = deploy(root, provider);
    const reached = readRuleDeliveryContext(report, provider);
    expect(reached).toContain('FIXTURE_KERNEL_BODY');
    expect(reached).toContain('Follow the fixture summary policy.');
    const dir = provider === 'opencode' ? '.opencode/rule' : provider === 'grok-build' ? '.grok/rules'
      : provider === 'copilot' ? '.github/instructions' : `.${provider}/rules`;
    expect(read(path.join(target, dir, 'fixture-kernel.md'))).toContain('FIXTURE_KERNEL_BODY');
    if (provider === 'windsurf') {
      expect(read(path.join(target, dir, 'fixture-kernel.md'))).toContain('trigger: always_on');
      const scoped = read(path.join(target, dir, 'fixture-paths.md'));
      expect(scoped).toContain('trigger: glob'); expect(scoped).toContain('glob: src/**');
      expect(scoped).toContain('FIXTURE_PATHS_BODY');
    } else {
      expect(read(path.join(target, dir, 'RULES-INDEX.md'))).toContain('src/**');
      expect(fs.existsSync(path.join(target, dir, 'fixture-paths.md'))).toBe(false);
    }
    if (provider === 'opencode') {
      const config = JSON.parse(read(path.join(target, 'opencode.json')));
      expect(config.instructions).toContain('.opencode/rule/**/*.md');
    }
    const before = read(path.join(target, dir, 'RULES-INDEX.md'));
    deploy(root, provider);
    expect(read(path.join(target, dir, 'RULES-INDEX.md'))).toBe(before);
  }, 90_000);

  it('keeps every shared AGENTS hook and operator text when upgrading a 20 KB inline bridge and regenerating', async () => {
    const { root, target } = setup();
    const bridge = path.join(target, 'AGENTS.md');
    fs.writeFileSync(bridge, '# Operator before\n<!-- BEGIN AIWG-managed (auto-generated; legacy) -->\n' + 'old generated '.repeat(1600) +
      '\n<!-- END AIWG-managed -->\n<!-- AIWG:rule-startup:start -->\nSTALE_KERNEL\n<!-- AIWG:rule-startup:end -->\nOperator after\n');
    const reports = ['codex', 'muse', 'factory'].map(provider => ({ provider, report: deploy(root, provider) }));
    for (const provider of ['codex', 'muse', 'factory'] as const) {
      await generate({ projectPath: target, provider, sections: [], detectExistingFiles: true });
    }
    for (const { provider, report } of reports) readRuleDeliveryContext(report, provider);
    const content = read(bridge);
    expect(content).toContain('# Operator before'); expect(content).toContain('Operator after');
    expect(content).not.toContain('STALE_KERNEL'); expect(content).not.toContain('old generated');
    expect(content).not.toContain('FIXTURE_KERNEL_BODY');
    expect(content.match(/CORE_POLICY/g)).toHaveLength(1);
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(4096);
  }, 90_000);

  it.each(['drop hook', 'drop kernel file', 'inline kernel body'])('negative control rejects %s, then passes after restoring', mutation => {
    const { root, target } = setup();
    const report = deploy(root, 'codex');
    const bridge = path.join(target, 'AGENTS.md'), kernel = path.join(target, '.codex/rules/fixture-kernel.md');
    const original = read(bridge), body = read(kernel);
    readRuleDeliveryContext(report, 'codex');
    if (mutation === 'drop hook') fs.writeFileSync(bridge, original.replace(/codex: Before every task[^\n]*/g, ''));
    if (mutation === 'drop kernel file') fs.rmSync(kernel);
    if (mutation === 'inline kernel body') fs.writeFileSync(bridge, original + '\n' + body.replace(/^---\n[\s\S]*?\n---\s*/, ''));
    expect(() => readRuleDeliveryContext(report, 'codex')).toThrow();
    console.info(`Negative control rejected: ${mutation}`);
    fs.writeFileSync(bridge, original); fs.writeFileSync(kernel, body);
    readRuleDeliveryContext(report, 'codex');
  }, 90_000);
});
