import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncFortemiCoreIndex } from '../../../src/artifacts/fortemi-core-sync.js';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { discoverCapability, showArtifact, compoundGoverningRules, governingRuleFields, governingRuleStats } from '../../../src/artifacts/query-engine.js';
import { buildRelations, relationId } from '../../../src/artifacts/relations-builder.js';
import { RelationsReader } from '../../../src/artifacts/relations.js';
import { getGraphIndexDir, type MetadataEntry, type ArtifactIndex } from '../../../src/artifacts/types.js';
// @ts-expect-error existing deployment helper is untyped
import { replaceBoundRulesBlock } from '../../../tools/agents/providers/base.mjs';
// @ts-expect-error existing probe harness is untyped
import { parseTrace, evaluateRequiredRuleChecks } from '../../../tools/rules/run-rule-probes.mjs';
const transport = vi.hoisted(() => vi.fn());
vi.mock('../../../src/mcp/helpers.mjs', async original => ({ ...await original<typeof import('../../../src/mcp/helpers.mjs')>(), runAiwgCli: transport }));
// @ts-expect-error MCP registration is untyped
import { registerDiscoveryTools } from '../../../src/mcp/tools/discovery.mjs';
let root: string;
let entries: MetadataEntry[];
let log: ReturnType<typeof vi.spyOn>;
const put = (file: string, text: string) => { const dest = path.join(root, '.aiwg', file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, text); };
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-compound-'));
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) vi.stubEnv(key, path.join(root, key));
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) vi.stubEnv(key, '');
  vi.stubEnv('AIWG_ROOT', root);
  put('skills/work/SKILL.md', '---\nname: work\ncapability: Work securely\npaths: ["src/secure/**"]\n---\n# Work\n');
  put('skills/worker/SKILL.md', '---\nname: worker\ncapability: Work securely\n---\n# Work assistant\n');
  put('skills/unbound/SKILL.md', '---\nname: unbound\n---\n# Unbound\n');
  put('flows/release.md', '---\ntype: flow\nname: release\n---\n# Release\n');
  put('rules/bound.md', '---\nname: bound\nactivation: bound\nenforcement: high\nsummary: Follow the bound policy.\nbound_to: {skills: [work, worker], flows: [release]}\ntriggers: [secure work]\n---\n# Bound\n');
  put('rules/paths.md', '---\nname: paths\nactivation: paths\nenforcement: critical\nsummary: Inspect secure code.\npaths: ["src/secure/**"]\n---\n# Paths\n');
  put('rules/trigger.md', '---\nname: trigger\nactivation: on-demand\nenforcement: medium\nsummary: Perform approval checks.\ntriggers: [approval request]\n---\n# Trigger\n');
  put('rules/kernel.md', '---\nname: kernel\nactivation: kernel\nenforcement: critical\ntriggers: [secure work]\n---\n# Kernel\n');
  await buildIndex(root, { graph: 'project', quiet: true });
  entries = Object.values((JSON.parse(fs.readFileSync(path.join(getGraphIndexDir(root, 'project'), 'metadata.json'), 'utf8')) as ArtifactIndex).entries);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
const target = (name: string) => entries.find(entry => entry.type === 'skill' && entry.name === name)!;
async function discover(phrase: string, json = true) {
  log.mockClear(); await discoverCapability(root, { phrase, typeFilter: ['skill'], graph: 'project', backend: 'local', json, limit: 10 });
  return json ? JSON.parse(String(log.mock.calls.at(-1)?.[0])) : log.mock.calls.map(call => call[0]).join('\n');
}
describe('compound action discovery (#3292)', () => {
  it('attaches bound/path/trigger rules once, excludes kernel, and gives explicit fetch-before-work checks', () => {
    const rules = compoundGoverningRules(entries, target('work'), undefined, 'secure work and approval request in src/secure/key.ts');
    expect(rules.map(item => item.rule.name)).toEqual(['bound', 'paths', 'trigger']);
    const legacy = { ...entries.find(entry => entry.name === 'kernel')!, name: 'legacy-kernel', path: '.aiwg/rules/legacy.md', activation: undefined };
    expect(compoundGoverningRules([...entries, legacy], target('unbound'), undefined, 'secure work')).toEqual([{ rule: entries.find(entry => entry.name === 'bound')!, applicability: ['trigger:secure work'] }]);
    expect(rules[0].applicability).toEqual(expect.arrayContaining([expect.stringMatching(/^bound:/), 'trigger:secure work']));
    const fields = governingRuleFields(rules);
    expect(fields.required_rule_checks).toHaveLength(3);
    expect(fields.required_rule_checks?.every(check => check.rule_id.startsWith('aiwg:rule:') && check.fetch_command.startsWith('aiwg show rule '))).toBe(true);
    expect(fields.rule_stats).toEqual({ by_enforcement: { high: 1, critical: 1, medium: 1 }, by_activation: { bound: 1, paths: 1, 'on-demand': 1 }, required_checks: 3 });
    expect(fields.rule_check_obligation).toContain('Before governed work, fetch and follow every required rule');
  });
  it('matches query paths and governed action paths, without substring triggers or unrelated path fetches', () => {
    expect(compoundGoverningRules(entries, target('unbound'), undefined, 'edit src/secure/key.ts').map(item => item.rule.name)).toEqual(['paths']);
    expect(compoundGoverningRules(entries, target('unbound'), undefined, 'edit src\\secure\\key.ts').map(item => item.rule.name)).toEqual(['paths']);
    expect(compoundGoverningRules(entries, target('unbound'), undefined, 'approval requester edits docs/index.md')).toEqual([]);
    expect(compoundGoverningRules(entries, target('unbound'), undefined, 'approval requester then approval request').map(item => item.rule.name)).toEqual(['trigger']);
    expect(compoundGoverningRules(entries, target('work')).map(item => item.rule.name)).toEqual(['bound', 'paths']);
    expect(governingRuleFields(compoundGoverningRules(entries, target('unbound')))).toEqual({});
  });
  it('uses small relationship records, preserving projected flow contracts and reader severity stats', () => {
    const flow = entries.find(entry => entry.type === 'flow')!;
    const reader = new RelationsReader(buildRelations(entries));
    const read = vi.spyOn(fs, 'readFileSync');
    expect(compoundGoverningRules([], flow, reader).map(item => item.rule.name)).toEqual(['bound']);
    const projection = { ...target('unbound'), name: 'projected:release' };
    expect(compoundGoverningRules([], projection, reader).map(item => item.rule.name)).toEqual(['bound']);
    expect(compoundGoverningRules([], target('work'), reader, 'approval request').map(item => item.rule.name)).toEqual(['bound', 'paths', 'trigger']);
    expect(read).not.toHaveBeenCalled();
    expect(reader.ruleStats('flow', 'release').required_checks).toBe(1);
    const pinnedId = relationId(entries.find(entry => entry.name === 'bound')!);
    const pinnedReader = new RelationsReader(buildRelations(entries), new Set([pinnedId]));
    expect(compoundGoverningRules([], target('work'), pinnedReader, 'approval request').map(item => item.rule.name)).toEqual(['paths', 'trigger']);
    expect(pinnedReader.pinnedRuleIds.has(pinnedId)).toBe(true);
    expect(pinnedReader.ruleStats('skill', 'work').by_activation.kernel).toBe(1);
  });
  it('does not mutate ranked artifacts and emits unique response totals instead of summing repeated bindings', async () => {
    const original = structuredClone(entries);
    const response = await discover('work');
    expect(response.results[0].name).toBe('work');
    expect(response.results[0].score).toBe(1);
    const boundRows = response.results.filter((row: any) => row.bound_rules?.some((rule: any) => rule.name === 'bound'));
    expect(boundRows.length).toBeGreaterThanOrEqual(2);
    expect(response.rule_stats.required_checks).toBe(2); // one shared bound rule and one secure path rule
    expect(response.required_rule_checks).toHaveLength(2);
    expect(response.rule_stats).toEqual(governingRuleStats(entries.filter(entry => ['bound', 'paths'].includes(entry.name ?? '')).map(rule => ({ rule, applicability: [] }))));
    expect(entries).toEqual(original);
    const unbound = await discover('unbound');
    const row = unbound.results.find((row: any) => row.name === 'unbound');
    expect(row).not.toHaveProperty('bound_rules'); expect(row).not.toHaveProperty('required_rule_checks'); expect(row).not.toHaveProperty('rule_stats');
  });
  it('text output groups governing pointers and an obligatory check summary under each result', async () => {
    const text = await discover('work', false);
    expect(text).toContain('rules:'); expect(text).toContain('required checks');
    expect(text).toContain('aiwg show rule bound'); expect(text).toContain('Before governed work, fetch and follow');
  });
  it('show and deployed blocks require fetching every governing rule on each invocation', async () => {
    await showArtifact(root, { name: 'work', typeFilter: ['skill'], graph: 'project', backend: 'local', json: true });
    const shown = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(shown.required_rule_checks).toHaveLength(1); expect(shown.rule_stats.required_checks).toBe(1);
    const text = replaceBoundRulesBlock('# Authored\n', [{ name: 'bound', summary: 'Follow policy.' }]);
    expect(text).toContain('Required reading on every invocation'); expect(text).toContain('before starting governed work');
    expect(text).toContain('aiwg show rule bound');
  });
  it('MCP discover forwards exactly the CLI compound JSON and required-check shape', async () => {
    const expected = await discover('work');
    transport.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(expected), stderr: '' });
    const handlers = new Map<string, any>();
    registerDiscoveryTools({ registerTool(name: string, _config: unknown, handler: unknown) { handlers.set(name, handler); } }, { corpusStore: {} });
    const result = await handlers.get('discover')({ phrase: 'work', type: 'skill', limit: 10 });
    expect(JSON.parse(result.content[0].text)).toEqual(expected);
    expect(transport).toHaveBeenCalledWith(['discover', 'work', '--json', '--limit', '10', '--type', 'skill']);
  });
  it('offline probe distinguishes completed-before-action fetches from missing, failed, late or parallel fetches', () => {
    const checks = [{ rule_id: 'aiwg:rule:bound', applicability: ['bound'], fetch_command: 'aiwg show rule bound' }];
    const use = (id: string, command: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
    const done = (id: string, is_error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: '# Full rule body', is_error }] } });
    const evaluate = (events: unknown[], required = checks) => evaluateRequiredRuleChecks(required, parseTrace(events.map(event => JSON.stringify(event)).join('\n'), 'claude'), 'perform-governed-work')[0].pass;
    expect(evaluate([use('fetch', 'aiwg show rule bound'), done('fetch'), use('action', 'perform-governed-work')])).toBe(true);
    expect(evaluate([use('fetch', 'aiwg show behavior aiwg:behavior:abc'), done('fetch'), use('action', 'perform-governed-work')], [{ ...checks[0], fetch_command: 'aiwg show behavior aiwg:behavior:abc' }])).toBe(true);
    expect(evaluate([use('action', 'perform-governed-work')])).toBe(false);
    expect(evaluate([use('fetch', 'aiwg show rule bound'), done('fetch', true), use('action', 'perform-governed-work')])).toBe(false);
    expect(evaluate([use('action', 'perform-governed-work'), use('fetch', 'aiwg show rule bound'), done('fetch')])).toBe(false);
    expect(evaluate([use('fetch', 'aiwg show rule bound'), use('action', 'perform-governed-work'), done('fetch')])).toBe(false);
  });
  it('retains governing path, trigger and enforcement metadata through the default Fortemi backend', async () => {
    const expected = await discover('work approval request src/secure/key.ts');
    await syncFortemiCoreIndex(root, { graph: 'project' });
    log.mockClear();
    await discoverCapability(root, { phrase: 'work approval request src/secure/key.ts', typeFilter: ['skill'], graph: 'project', backend: 'fortemi-core', json: true, limit: 10 });
    const actual = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    const row = actual.results.find((row: any) => row.name === 'work');
    expect(row.bound_rules.map((rule: any) => rule.name)).toEqual(['bound', 'paths', 'trigger']);
    expect(row.rule_stats).toEqual(expected.results.find((row: any) => row.name === 'work').rule_stats);
    expect(row.required_rule_checks.every((check: any) => check.fetch_command.endsWith(check.rule_id))).toBe(true);
  });

});
