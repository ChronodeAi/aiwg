import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { resolveRulePins, validateRulePinCapabilities, loadRulePinConfigs, installedRuleCapabilities } from '../../../src/rules/pins.mjs';
import { validateRulesConfig } from '../../../src/rules/inline-budget.mjs';
import { RelationsReader, emptyRuleStats, type RelationsIndex } from '../../../src/artifacts/relations.js';
import { main as configMain } from '../../../src/config/cli.js';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-pins-'));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('AIWG_CONFIG', join(root, 'home/.aiwg'));
  vi.stubEnv('AIWG_USER_REGISTRY_PATH', join(root, 'home/installed.json'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'xdg-config'));
  vi.stubEnv('XDG_DATA_HOME', join(root, 'xdg-data'));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
const inventory = [
  { id: 'a', name: 'token-security', capability: 'security-engineering', enforcement: 'critical', activation: 'bound', path: 'a.md' },
  { id: 'b', name: 'no-attribution', capability: 'aiwg-utils', enforcement: 'high', activation: 'summary', path: 'b.md' },
  { id: 'c', name: 'design', capability: 'sdlc-complete', enforcement: 'high', activation: 'paths', path: 'c.md' },
  { id: 'd', name: 'detail', capability: 'sdlc-complete', enforcement: 'low', activation: 'on-demand', path: 'd.md' },
];
const installed = ['security-engineering', 'aiwg-utils', 'sdlc-complete'];
function resolve(selectors: any[], extra: any = {}) {
  return resolveRulePins({ rules: inventory, installed, configs: { user: {}, project: { rules: { always_load: selectors, pin_groups: { compliance: ['security-engineering', 'sdlc-complete'] } } } }, ...extra });
}
describe('operator pin selectors', () => {
  it.each([
    [{ rules: ['token-security', 'no-attribution'] }, ['a', 'b']],
    [{ enforcement: ['critical'] }, ['a']],
    [{ enforcement: ['high'], capabilities: ['sdlc-complete'] }, ['c']],
    [{ enforcement: ['critical', 'high'], capabilities: ['sdlc-complete', 'security-engineering'] }, ['a', 'c']],
    [{ capabilities: ['sdlc-complete'] }, ['c', 'd']],
    [{ group: 'compliance' }, ['a', 'c', 'd']],
    [{ group: 'compliance', enforcement: ['critical'] }, ['a']],
    [{ all: true }, ['a', 'b', 'c', 'd']],
  ])('matches %j', (selector, ids) => {
    const pins = resolve([selector]);
    expect(pins.rules.map(rule => rule.id)).toEqual(ids);
    expect(pins.rules.every(rule => rule.activation === 'kernel')).toBe(true);
    expect(pins.warnings).toEqual([]);
  });
  it('deduplicates overlapping selectors, preserving sources and canonical activation', () => {
    const pins = resolve([{ all: true }, { rules: ['token-security'] }], { configs: {
      user: { rules: { always_load: [{ rules: ['token-security'] }] } },
      project: { rules: { always_load: [{ all: true }, { rules: ['token-security'] }] } },
    } });
    expect(pins.rules).toHaveLength(4);
    expect(pins.rules[0].matches).toHaveLength(3);
    expect(pins.rules[0].canonical_activation).toBe('bound');
  });
  it('drops uninstalled capability pins with a warning and lists installed ids', () => {
    const pins = resolve([{ capabilities: ['security-engineering'] }], { installed: ['aiwg-utils'] });
    expect(pins.rules).toEqual([]);
    expect(pins.warnings.join()).toContain("uninstalled capability 'security-engineering'");
    expect(pins.warnings.join()).toContain('Installed ids: aiwg-utils');
  });
  it('resolves existing installed framework aliases to corpus capability ids', () => {
    expect(installedRuleCapabilities({ user: {}, project: { installed: { sdlc: {}, ops: {} } } })).toEqual(['ops-complete', 'sdlc-complete']);
    const all = installedRuleCapabilities({ user: {}, project: { installed: { all: {} } } });
    expect(all).toContain('aiwg-utils');
    expect(all).toContain('sdlc-complete');
    expect(all).not.toContain('aiwg-dev');
    const pins = resolveRulePins({ rules: inventory, configs: { user: {}, project: { installed: { sdlc: {} }, rules: { always_load: [{ capabilities: ['sdlc-complete'], enforcement: ['high'] }] } } } });
    expect(pins.rules.map(rule => rule.id)).toEqual(['c']);
  });
  it('uses the relationship capability/tier reader', () => {
    const relations = new RelationsReader({ capabilities: { 'framework:sdlc-complete': { rules_by_tier: { high: ['c'] } } }, rules: { c: { path: 'c.md' } } } as unknown as RelationsIndex);
    const spy = vi.spyOn(relations, 'rulesForCapability');
    expect(resolve([{ enforcement: ['high'], capabilities: ['sdlc-complete'] }], { relations }).rules.map(rule => rule.id)).toEqual(['c']);
    expect(spy).toHaveBeenCalledWith('framework:sdlc-complete', ['high']);
  });
  it('whole-capability selectors include rules with no tier in the sidecar', () => {
    const rules = [{ ...inventory[0], enforcement: null }];
    const relations = new RelationsReader({ capabilities: { 'framework:security-engineering': { rules_by_tier: { critical: [], high: [], medium: [], low: [] } } }, rules: { a: { ...rules[0] } } } as unknown as RelationsIndex);
    const pins = resolveRulePins({ rules, relations, installed, configs: { user: {}, project: { rules: { always_load: [{ capabilities: ['security-engineering'] }] } } } });
    expect(pins.rules.map(rule => rule.id)).toEqual(['a']);
  });
  it('counts pins as kernel in rule stats without mutating canonical sidecars', () => {
    const stats = { ...emptyRuleStats(), by_activation: { bound: 1 }, by_enforcement: { critical: 1 }, required_checks: 1 };
    const index = { rules: { a: inventory[0] }, targets: { 'agent:x': { rules: ['a'], rule_stats: stats } }, aliases: { targets: {} } } as unknown as RelationsIndex;
    expect(new RelationsReader(index, new Set(['a'])).ruleStats('agent', 'x').by_activation).toEqual({ kernel: 1 });
    expect(stats.by_activation).toEqual({ bound: 1 });
  });
  it.each([{}, { all: false }, { all: true, rules: ['a'] }, { enforcement: ['CRITICAL'] }, { capabilities: [] }, { group: 'x', capabilities: ['a'] }, { typo: true }])('rejects invalid selector %j', selector => {
    expect(validateRulesConfig({ always_load: [selector] }).length).toBeGreaterThan(0);
  });
  it('validates unknown capability ids and groups', () => {
    expect(validateRulePinCapabilities({ always_load: [{ capabilities: ['typo'] }] }, installed).join()).toContain('Installed ids: security-engineering, aiwg-utils, sdlc-complete');
    expect(validateRulePinCapabilities({ always_load: [{ group: 'missing' }] }, installed).join()).toContain('unknown pin group');
  });
  it('schema accepts all selectors and rejects invalid forms', () => {
    const schema = JSON.parse(readFileSync('vscode-extension/schemas/aiwg.config.v1.json', 'utf8'));
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(schema.properties.rules);
    expect(validate({ always_load: [{ all: true }, { rules: ['x'] }, { enforcement: ['critical'], group: 'compliance' }], pin_groups: { compliance: ['aiwg-utils'] } })).toBe(true);
    expect(validate({ always_load: [{ all: true, capabilities: ['x'] }] })).toBe(false);
  });
  it('config validate rejects unknown user pin capabilities', async () => {
    mkdirSync(join(root, 'home/.aiwg'), { recursive: true });
    writeFileSync(join(root, 'home/.aiwg/aiwg.config'), JSON.stringify({ rules: { always_load: [{ capabilities: ['missing'] }] } }));
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(configMain(['validate', '--user'])).rejects.toThrow('Config validation failed');
    expect(log.mock.calls.flat().join()).toContain('Installed ids: (none)');
  });
  it('config set validates user pins and retains unrelated user config', async () => {
    mkdirSync(join(root, '.aiwg'), { recursive: true });
    writeFileSync(join(root, '.aiwg/aiwg.config'), JSON.stringify({ installed: { 'aiwg-utils': {} } }));
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await configMain(['set', '--user', 'rules.always_load', '[{"capabilities":["aiwg-utils"]}]']);
    expect(loadRulePinConfigs(root).user.rules?.always_load).toEqual([{ capabilities: ['aiwg-utils'] }]);
    await expect(configMain(['set', '--user', 'rules.always_load', '[{"capabilities":["typo"]}]'])).rejects.toThrow('Installed ids: aiwg-utils');
    expect(loadRulePinConfigs(root).user.rules?.always_load).toEqual([{ capabilities: ['aiwg-utils'] }]);
  });
});
