import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isolatedEnvironment, measureDeployed, measureStartupContext, measurementGates, ROOT }
  from '../../../tools/rules/measure-startup-context.mjs';
import { deployRules as deployClaudeRules } from '../../../tools/agents/providers/claude.mjs';
import { deployRules as deployCursorRules } from '../../../tools/agents/providers/cursor.mjs';
import { deployEmulatedBehaviors } from '../../../tools/agents/providers/base.mjs';

const temps = [];
afterEach(() => { for (const temp of temps.splice(0)) fs.rmSync(temp, { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-rule-unit-')); temps.push(dir); return dir; }
function write(root, name, content) {
  const dest = path.join(root, name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, content);
}
const source = path.join(ROOT, 'test/fixtures/rule-binding/source');
const ruleFiles = ['tiny.md', 'scoped.md'].map(name => path.join(source, 'rules', name));

describe('startup context measurement', () => {
  it('measures actual provider output including nested Claude behavior bytes, in a disposable fixture', async () => {
    const targets = [], expected = {};
    const report = await measureStartupContext({ providers: ['claude', 'cursor'], deploy: ({ project, home, provider }) => {
      targets.push(project, home);
      expect(fs.readFileSync(path.join(project, 'README.md'), 'utf8')).toContain('Rule binding fixture');
      expect(fs.readdirSync(home)).toEqual([]);
      (provider === 'claude' ? deployClaudeRules : deployCursorRules)(ruleFiles, project, { force: true });
      deployEmulatedBehaviors([path.join(source, 'behaviors/heartbeat')], provider, project);
      if (provider === 'claude') {
        expected.rules = fs.readdirSync(path.join(project, '.claude/rules')).filter(name => name.endsWith('.md'))
          .reduce((sum, name) => sum + fs.statSync(path.join(project, '.claude/rules', name)).size, 0);
        expected.behaviors = fs.statSync(path.join(project, '.claude/rules/behaviors/heartbeat.md')).size;
      }
    } });
    expect(report.providers.claude.rules.bytes).toBe(expected.rules);
    expect(report.providers.claude.behaviors.bytes).toBe(expected.behaviors);
    expect(report.providers.claude.startup.bytes).toBe(expected.rules + expected.behaviors);
    expect(report.providers.claude.behaviors.files).toHaveLength(1);
    expect(report.providers.cursor.rules.files).toHaveLength(1);
    expect(report.providers.cursor.conditional.files).toHaveLength(1);
    expect(report.providers.cursor.mirrors.files).toHaveLength(1); // emulation is .md, not MDC
    expect(targets.every(target => !fs.existsSync(target))).toBe(true);
  });

  it('cleans temp project and HOME even when the real deploy owner fails', async () => {
    let target;
    await expect(measureStartupContext({ providers: ['claude'], deploy: ({ project }) => {
      target = path.dirname(project); throw new Error('fixture deploy failed');
    } })).rejects.toThrow('fixture deploy failed');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('does not import operator config, credentials, provider homes, or rule-budget overrides', () => {
    const env = isolatedEnvironment('/tmp/fixture-home');
    expect(env.HOME).toBe('/tmp/fixture-home');
    expect(env.XDG_CONFIG_HOME).toBe('/tmp/fixture-home/.config');
    expect(env.AIWG_RULES_INLINE_BUDGET_TOKENS).toBeUndefined();
    expect(env.AIWG_CONFIG).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.NO_UPDATE_NOTIFIER).toBe('1');
  });

  it('counts indexes and UTF-8 bytes, excludes sidecars, and keeps Codex mirrors out of startup', () => {
    const project = tempDir(), home = tempDir();
    write(project, '.claude/rules/RULES-ONDEMAND.md', 'é\n');
    write(project, '.claude/rules/.aiwg-rules-budget.json', '{"demoted":["large"],"budgetTokens":64000}');
    write(project, '.codex/rules/tiny.md', 'mirror');
    const claude = measureDeployed(project, home, 'claude');
    expect(claude.rules.bytes).toBe(3);
    expect(claude.rules.estimated_tokens).toBe(1);
    expect(claude.budget.demoted).toEqual(['large']);
    expect(measureDeployed(project, home, 'codex').startup.bytes).toBe(0);
    expect(measureDeployed(project, home, 'codex').mirrors.bytes).toBe(6);
  });

  it('counts Claude paths rules as conditional, not startup', () => {
    const project = tempDir(), home = tempDir();
    write(project, '.claude/rules/kernel.md', '---\nenforcement: high\n---\nKERNEL\n');
    write(project, '.claude/rules/scoped.md', '---\n# aiwg:managed vunknown bundled\nenforcement: medium\npaths:\n  - src/**\n---\nSCOPED\n');
    write(project, '.claude/rules/mentions-paths.md', 'Body text naming\npaths: in prose only\n');
    const claude = measureDeployed(project, home, 'claude');
    const kernelBytes = Buffer.byteLength('---\nenforcement: high\n---\nKERNEL\n') + Buffer.byteLength('Body text naming\npaths: in prose only\n');
    expect(claude.startup.bytes).toBe(kernelBytes);
    expect(claude.conditional.files.map(file => file.path)).toEqual(['.claude/rules/scoped.md']);
  });

  it('measures aggregated Warp/Hermes rule sections and global OpenClaw rule files', () => {
    const project = tempDir(), home = tempDir();
    write(project, 'WARP.md', '# Context\n## AIWG Rules\n\n### Tiny\nRule body.\n---\n### Second\nAnother rule.\n---\n\n## Other\nUnrelated.\n');
    write(project, 'AGENTS.md', '# Context\n## CRITICAL Rules (always apply)\n\n### Tiny\nDo this.\n## Skills\nUnrelated.\n');
    write(home, '.openclaw/rules/tiny.md', 'global rule');
    const warp = measureDeployed(project, home, 'warp');
    expect(warp.rules.bytes).toBe(Buffer.byteLength('## AIWG Rules\n\n### Tiny\nRule body.\n---\n### Second\nAnother rule.\n'));
    expect(measureDeployed(project, home, 'hermes').rules.bytes)
      .toBe(Buffer.byteLength('## CRITICAL Rules (always apply)\n\n### Tiny\nDo this.\n'));
    expect(measureDeployed(project, home, 'openclaw').rules.bytes).toBe(11);
  });

  it('gates inclusive Claude bytes and every baseline provider, including missing measurements', () => {
    const report = { providers: { claude: { rules: { bytes: 207444 }, behaviors: { bytes: 33411 }, startup: { bytes: 240855 } } } };
    expect(measurementGates(report, { checkPo: true }).every(gate => gate.pass)).toBe(true);
    expect(measurementGates(report, { maxClaudeBytes: 207444 })[0].pass).toBe(false);
    const gates = measurementGates(report, { baseline: { providers: { claude: { startup: { bytes: 240000 } }, codex: { startup: { bytes: 0 } } } } });
    expect(gates.map(gate => gate.pass)).toEqual([false, false]);
  });
});
