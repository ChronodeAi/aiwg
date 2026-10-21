import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { rulesHandler } from '../../../src/cli/handlers/rules.js';
import { buildHandlerMap } from '../../../src/cli/handlers/index.js';
import { rulePinState } from '../../../src/rules/pin-state.js';
import { emptyConfig, writeAiwgConfig, readAiwgConfig } from '../../../src/config/aiwg-config.js';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { showArtifact } from '../../../src/artifacts/query-engine.js';
import { doctorHandler } from '../../../src/cli/handlers/utilities.js';
import { main as configMain } from '../../../src/config/cli.js';
let root: string;
const repo = resolve(__dirname, '../../..');
const run = (args: string[], frameworkRoot = repo) => rulesHandler.execute({ args, rawArgs: ['rules', ...args], cwd: root, frameworkRoot });
const configFile = () => join(root, '.aiwg/aiwg.config');
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-rules-cli-'));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('AIWG_CONFIG', join(root, 'home/.aiwg'));
  vi.stubEnv('AIWG_USER_REGISTRY_PATH', join(root, 'home/installed.json'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'xdg-config'));
  vi.stubEnv('XDG_DATA_HOME', join(root, 'xdg-data'));
  vi.stubEnv('AIWG_ARTIFACTS_PATH', join(root, 'artifacts'));
  vi.stubEnv('AIWG_RULES_INLINE_BUDGET_TOKENS', '0');
  mkdirSync(join(root, '.aiwg'), { recursive: true });
  cpSync(join(repo, 'test/fixtures/rule-delivery'), join(root, 'bundle'), { recursive: true });
  writeFileSync(configFile(), JSON.stringify({ ...emptyConfig(), providers: [], installed: {
    fixture: { version: '1', source: 'project-local', localPath: 'bundle', deployedTo: {}, installedAt: '' },
  } }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
describe('rules command', () => {
  it('is registered in the handler registry', () => expect(buildHandlerMap().get('rules')).toBe(rulesHandler));
  it('inventories installed local rules with composed filters, pin provenance and complete bodies without writes', async () => {
    const config = JSON.parse(readFileSync(configFile(), 'utf8'));
    config.rules = { always_load: [{ rules: ['fixture-bound'] }] };
    writeFileSync(configFile(), JSON.stringify(config));
    const before = readFileSync(configFile(), 'utf8');
    const result = await run(['inventory', '--capability', 'fixture', '--activation', 'kernel', '--tier', 'critical', '--bodies', '--json']);
    expect(result.exitCode, result.message).toBe(0);
    const report = JSON.parse(result.message!);
    const bound = report.rules.find((rule: any) => rule.name === 'fixture-bound');
    expect(bound.canonical_activation).toBe('bound');
    expect(bound.effective_activation).toBe('kernel');
    expect(bound.pin_reasons[0].source).toBe('project');
    expect(bound.bound_to.skills).toContain('fixture-skill');
    expect(bound.summary).toBe('Follow the fixture bound policy.');
    expect(bound.content).toBe(readFileSync(join(root, 'bundle/rules/fixture-bound.md'), 'utf8'));
    expect(bound.delivery).toBe('unknown');
    expect(bound.session_loaded).toBe('unknown');
    expect(readFileSync(configFile(), 'utf8')).toBe(before);
    const compact = await run(['list', '--capability', 'addon:fixture', '--activation', 'kernel']);
    expect(compact.message).toContain('Follow the fixture bound policy.');
    expect(compact.message).not.toContain('pin_reasons');
  });
  it('distinguishes user configuration from workspace and treats catalog availability as unconfigured', async () => {
    const user = JSON.parse((await run(['list', '--scope', 'user', '--json'])).message!);
    expect(user.rules).toEqual([]);
    const workspace = JSON.parse((await run(['list', '--scope', 'workspace', '--json'])).message!);
    expect(workspace.rules.some((rule: any) => rule.capability === 'fixture')).toBe(true);
    const catalog = JSON.parse((await run(['list', '--scope', 'catalog', '--capability', 'aiwg-utils', '--json'])).message!);
    expect(catalog.rules.length).toBeGreaterThan(0);
    expect(catalog.rules.every((rule: any) => !rule.configured && rule.effective_activation === null)).toBe(true);
    expect((await run(['list', '--scope', 'unknown'])).exitCode).toBe(1);
  });
  it('rejects invalid filters and returns an explicit empty result', async () => {
    expect((await run(['inventory', '--activation', 'bogus'])).exitCode).toBe(1);
    expect((await run(['inventory', '--tier', 'bogus'])).exitCode).toBe(1);
    const result = await run(['inventory', '--capability', 'not-installed', '--json']);
    expect(JSON.parse(result.message!).rules).toEqual([]);
  });
  it('filters providers using recorded capability deployment without claiming rule delivery', async () => {
    const config = JSON.parse(readFileSync(configFile(), 'utf8'));
    config.installed.fixture.deployedTo = { codex: { skills: 1 } };
    writeFileSync(configFile(), JSON.stringify(config));
    const report = JSON.parse((await run(['inventory', '--provider', 'codex', '--json'])).message!);
    expect(report.rules.length).toBe(5);
    expect(report.rules[0].configured_providers).toEqual(['codex']);
    expect(report.rules[0].delivery).toBe('unknown');
    expect(JSON.parse((await run(['inventory', '--provider', 'claude', '--json'])).message!).rules).toEqual([]);
  });
  it.each([
    [['pin', 'fixture-bound'], { rules: ['fixture-bound'] }],
    [['pin', '--tier', 'critical'], { enforcement: ['critical'] }],
    [['pin', '--tier', 'critical', '--capability', 'fixture'], { enforcement: ['critical'], capabilities: ['fixture'] }],
    [['pin', '--capability', 'fixture', '--all-tiers'], { capabilities: ['fixture'] }],
    [['pin', '--all'], { all: true }],
  ])('persists %j without prompts', async (args, selector) => {
    const result = await run([...args, '--no-deploy', '--json']);
    expect(result.exitCode, result.message).toBe(0);
    expect(JSON.parse(readFileSync(configFile(), 'utf8')).rules.always_load).toEqual([selector]);
    expect(JSON.parse(result.message!).redeploy).toContain('aiwg refresh');
  });
  it('dry-run lists rules without writing config and no-deploy prints redeploy command', async () => {
    const before = readFileSync(configFile(), 'utf8');
    const result = await run(['pin', '--all', '--dry-run', '--json']);
    expect(result.exitCode, result.message).toBe(0);
    expect(JSON.parse(result.message!).rules).toHaveLength(5);
    expect(readFileSync(configFile(), 'utf8')).toBe(before);
    expect((await run(['pin', '--all', '--no-deploy'])).message).toContain('Redeploy: aiwg refresh');
  });
  it('unpins exactly a matching normalized selector and is idempotent', async () => {
    await run(['pin', 'fixture-summary', 'fixture-bound', '--no-deploy']);
    await run(['pin', '--all', '--no-deploy']);
    await run(['unpin', 'fixture-bound', 'fixture-summary', '--no-deploy']);
    expect(JSON.parse(readFileSync(configFile(), 'utf8')).rules.always_load).toEqual([{ all: true }]);
    const before = readFileSync(configFile(), 'utf8');
    await run(['unpin', 'fixture-bound', 'fixture-summary', '--no-deploy']);
    expect(readFileSync(configFile(), 'utf8')).toBe(before);
  });
  it('sets reusable groups, pins tier subsets, and reports both config sources', async () => {
    expect((await run(['group', 'set', 'compliance', 'fixture', '--user', '--json', '--no-deploy'])).exitCode).toBe(0);
    expect((await run(['pin', '--group', 'compliance', '--tier', 'critical', '--no-deploy'])).exitCode).toBe(0);
    await run(['pin', 'fixture-bound', '--user', '--no-deploy']);
    const pinned = JSON.parse((await run(['pinned', '--capability', 'fixture', '--json'])).message!);
    expect(pinned.rules).toHaveLength(3);
    const bound = pinned.rules.find((rule: any) => rule.name === 'fixture-bound');
    expect(bound.canonical_activation).toBe('bound');
    expect(bound.matches.map((match: any) => match.source)).toEqual(['user', 'project']);
    const groups = JSON.parse((await run(['group', 'list', '--json'])).message!);
    expect(groups.user.compliance).toEqual(['fixture']);
  });
  it.each([
    ['pin'], ['pin', '--tier'], ['pin', '--tier', 'unknown'], ['pin', '--capability', 'missing'],
    ['pin', '--group', 'missing'], ['pin', '--all', '--tier', 'high'], ['pin', '--all-tiers'],
    ['pin', '--tier', 'high', '--all-tiers'], ['pin', 'missing-rule'], ['pin', '--bogus'],
    ['pin', '--capability', 'fixture,'], ['group', 'set', 'compliance'],
  ])('rejects invalid headless input %j without writing', async (...args) => {
    const before = readFileSync(configFile(), 'utf8');
    const result = await run([...args, '--json']);
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.message!).error).toBeTruthy();
    expect(readFileSync(configFile(), 'utf8')).toBe(before);
  });
  it('config set and loader validate project selector shape and capability ids', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await configMain(['set', '--project', 'rules.always_load', '[{"capabilities":["fixture"]}]']);
    expect((await readAiwgConfig(root))?.rules?.always_load).toEqual([{ capabilities: ['fixture'] }]);
    await expect(configMain(['set', '--project', 'rules.always_load', '[{"capabilities":["missing"]}]'])).rejects.toThrow('Installed ids: fixture');
    const config = JSON.parse(readFileSync(configFile(), 'utf8'));
    config.rules.always_load = [{ enforcement: ['typo'] }];
    await expect(writeAiwgConfig(root, config)).rejects.toThrow('enforcement');
  });
  it('preview reports every provider budget failure before persisting config', async () => {
    const frameworkRoot = join(root, 'provider-fixture');
    mkdirSync(join(frameworkRoot, 'agentic/code/frameworks'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'agentic/code/addons'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'tools/agents/providers'), { recursive: true });
    for (const provider of ['claude', 'cursor']) {
      const implementation = pathToFileURL(join(repo, 'tools/agents/providers', `${provider}.mjs`)).href;
      writeFileSync(join(frameworkRoot, 'tools/agents/providers', `${provider}.mjs`), `export { deploy } from ${JSON.stringify(implementation)};\n`);
    }
    vi.stubEnv('AIWG_ROOT', frameworkRoot);
    vi.stubEnv('AIWG_RULE_BINDING_INDEX_CACHE', join(root, 'binding-index-cache'));
    const config = JSON.parse(readFileSync(configFile(), 'utf8'));
    config.providers = ['claude', 'cursor'];
    writeFileSync(configFile(), JSON.stringify(config));
    vi.stubEnv('AIWG_RULES_INLINE_BUDGET_TOKENS', '1');
    const before = readFileSync(configFile(), 'utf8');
    const failed = await run(['pin', 'fixture-on-demand', '--no-deploy', '--json'], frameworkRoot);
    expect(failed.exitCode).toBe(1);
    expect(failed.message).toContain('claude');
    expect(failed.message).toContain('cursor');
    expect(failed.message).toContain('fixture-on-demand');
    expect(readFileSync(configFile(), 'utf8')).toBe(before);
    const allowed = await run(['pin', 'fixture-on-demand', '--dry-run', '--allow-over-budget', '--json'], frameworkRoot);
    expect(allowed.exitCode, allowed.message).toBe(0);
    expect(JSON.parse(allowed.message!).providers).toHaveLength(2);
    expect(existsSync(join(root, '.claude/rules/fixture-on-demand.md'))).toBe(false);
  });
  it('shows a minimal local pin note and exposes status/doctor pin origins', async () => {
    await run(['pin', 'fixture-bound', '--no-deploy']);
    vi.stubEnv('AIWG_ROOT', repo);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await buildIndex(root, { scope: 'bundle', graph: 'project', force: true, quiet: true });
    await showArtifact(root, { name: 'fixture-bound', typeFilter: ['rule'], graph: 'project', backend: 'local', json: true });
    const shown = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(shown.local_pin.canonical_activation).toBe('bound');
    expect(shown.local_pin.matches[0].source).toBe('project');
    write.mockClear();
    await showArtifact(root, { name: 'fixture-bound', typeFilter: ['rule'], graph: 'project', backend: 'local', json: false });
    expect(write.mock.calls.map(call => String(call[0])).join('')).toContain('Pinned locally: kernel (canonical bound; project).');
    const { buildWorkspaceStatus } = await import('../../../tools/cli/workspace-status.mjs');
    expect((await buildWorkspaceStatus(root)).rule_pins.rules[0].canonical_activation).toBe('bound');
    const doctor = await doctorHandler.execute({ args: ['--deployment', '--json'], rawArgs: ['doctor', '--deployment', '--json'], cwd: root, frameworkRoot: repo });
    expect(JSON.parse(doctor.message!).rule_pins.rules[0].canonical_activation).toBe('bound');
  });
  it('selects rules in an installed plugin payload by plugin id', async () => {
    mkdirSync(join(root, 'plugin-wrapper'), { recursive: true });
    cpSync(join(root, 'bundle'), join(root, 'plugin-wrapper/payload'), { recursive: true });
    writeFileSync(join(root, 'plugin-wrapper/manifest.json'), JSON.stringify({ pluginConfig: { payloadPath: 'payload' } }));
    const config = JSON.parse(readFileSync(configFile(), 'utf8'));
    config.installed = { 'local-plugin': { source: 'project-local', localPath: 'plugin-wrapper', localType: 'plugin', deployedTo: {} } };
    writeFileSync(configFile(), JSON.stringify(config));
    const result = await run(['pin', '--capability', 'local-plugin', '--no-deploy', '--json']);
    expect(result.exitCode, result.message).toBe(0);
    const pins = JSON.parse(result.message!).rules;
    expect(pins).toHaveLength(5);
    expect(pins.every((rule: any) => rule.capability === 'local-plugin' && rule.path.includes('/payload/rules/'))).toBe(true);
  });
  it('uninstall writes retire project capability pins with a warning', async () => {
    await run(['group', 'set', 'compliance', 'fixture', '--no-deploy']);
    await run(['pin', '--capability', 'fixture', '--no-deploy']);
    await run(['pin', '--group', 'compliance', '--no-deploy']);
    const config = JSON.parse(readFileSync(configFile(), 'utf8'));
    config.installed = {};
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeAiwgConfig(root, config);
    expect(warning.mock.calls.flat().join()).toContain('effective pinned set');
    expect((await readAiwgConfig(root))?.rules?.always_load).toEqual([]);
    expect(rulePinState(root, repo).rules).toEqual([]);
  });
  it('uninstalled groups become effective warnings', async () => {
    await run(['group', 'set', 'compliance', 'fixture', '--no-deploy']);
    await run(['pin', '--group', 'compliance', '--no-deploy']);
    const config = JSON.parse(readFileSync(configFile(), 'utf8'));
    config.installed = {};
    writeFileSync(configFile(), JSON.stringify(config));
    const state = rulePinState(root, repo);
    expect(state.rules).toEqual([]);
    expect(state.warnings.join()).toContain('uninstalled capability');
  });
});
