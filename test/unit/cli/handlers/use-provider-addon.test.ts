/** #3035: real addon deploy pipeline with synthetic sources and isolated homes. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { emptyConfig, readAiwgConfig, writeAiwgConfig } from '../../../../src/config/aiwg-config.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PROVIDERS = [
  'pi', 'openclaw', 'opencode', 'copilot', 'muse', 'openhuman',
  'grokbot', 'grok-build', 'deepseek-harness', 'windsurf',
] as const;

// Node's homedir() observes the parent environment in Vitest worker threads.
// Keep both import spellings aligned with the per-test JS environment that
// the real deploy subprocess inherits.
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => process.env.HOME!;
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => process.env.HOME!;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('../../../../src/channel/manager.mjs', () => ({
  getFrameworkRoot: vi.fn(async () => 'mock-framework-root'),
  getVersionInfo: vi.fn(async () => ({ version: 'test', channel: 'test', devMode: true })),
}));

// Exercise the checkout's deployer while use resolves tiny synthetic addons.
vi.mock('../../../../src/cli/handlers/script-runner.js', () => ({
  createScriptRunner: () => ({
    run: async (script: string, args: string[] = []) => {
      try {
        const targetIndex = args.indexOf('--target');
        execFileSync(process.execPath, [join(REPO_ROOT, script), ...args], {
          cwd: args[targetIndex + 1], stdio: 'pipe', env: process.env, timeout: 60_000,
        });
        return { exitCode: 0 };
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        return { exitCode: typeof status === 'number' ? status : 1, message: (error as Error).message };
      }
    },
  }),
}));

// Redirect every provider config/home override, including overrides belonging
// to adapters eagerly imported by the deployer. Never inspect the real home.
const ISOLATED_ENV = [
  'HOME', 'USERPROFILE', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'CODEX_HOME', 'HERMES_HOME', 'OPENHUMAN_HOME', 'OPENCLAW_HOME', 'GROK_HOME', 'DSH_HOME',
  'PI_CODING_AGENT_DIR', 'OMP_CODING_AGENT_DIR', 'AIWG_GROKBOT_SKILLS_DIR',
] as const;
const UNSET_ENV = ['AIWG_ROOT', 'AIWG_HOME', 'OPENCLAW_PROFILE', 'AIWG_USER_REGISTRY_PATH'] as const;

function write(root: string, relative: string, content: string): void {
  const destination = join(root, relative);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function writeSources(root: string): void {
  mkdirSync(join(root, 'agentic/code/frameworks'), { recursive: true });
  write(root, 'agentic/code/providers/model-catalog.v1.json', JSON.stringify({
    version: '1.0.0', refreshedAt: '2026-10-12',
    providers: Object.fromEntries(PROVIDERS.map(provider => [provider, { roles: {} }])),
  }));
  // The harness deployer expects its shipped patch to be present.
  write(root, 'agentic/code/providers/deepseek-harness/aiwg.cordis.patch.yml', '# synthetic patch\n');
  const addons = 'agentic/code/addons';
  write(root, `${addons}/aiwg-utils/manifest.json`, JSON.stringify({ id: 'aiwg-utils', version: '1.0.0' }));
  write(root, `${addons}/aiwg-utils/skills/sess-probe/SKILL.md`,
    '---\nnamespace: aiwg\nname: sess-probe\nplatforms: [all]\ndescription: synthetic session probe\nmetadata:\n  entrypoint: session-entry.md\n---\n\nProbe [recipe](references/recipes.md).\n');
  write(root, `${addons}/aiwg-utils/skills/sess-probe/session-entry.md`, '# synthetic entrypoint\n');
  write(root, `${addons}/aiwg-utils/skills/sess-probe/references/recipes.md`, '# synthetic recipes\n');
  write(root, `${addons}/aiwg-utils/skills/kern-probe/SKILL.md`,
    '---\nnamespace: aiwg\nname: kern-probe\nplatforms: [all]\nkernel: true\ndescription: synthetic kernel probe\nmetadata:\n  entrypoint: kernel-entry.md\n---\n\nKernel probe.\n');
  write(root, `${addons}/aiwg-utils/skills/kern-probe/kernel-entry.md`, '# kernel entrypoint\n');
  write(root, `${addons}/decision-engine/manifest.json`, JSON.stringify({
    id: 'decision-engine', version: '1.0.0', explicitInstall: true,
    dependencies: { required: ['aiwg-utils'] },
  }));
  write(root, `${addons}/decision-engine/skills/de-check/SKILL.md`,
    '---\nnamespace: aiwg\nname: de-check\nplatforms: [all]\ndescription: synthetic decision check\n---\n\nCheck body.\n');
}

describe('aiwg use addon requiring aiwg-utils across providers (#3035)', () => {
  let frameworkRoot: string;
  let tempRoot: string;
  let project: string;

  beforeAll(() => {
    frameworkRoot = mkdtempSync(join(tmpdir(), 'aiwg-addon-sources-'));
    writeSources(frameworkRoot);
  });
  afterAll(() => rmSync(frameworkRoot, { recursive: true, force: true }));

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'aiwg-addon-provider-'));
    project = join(tempRoot, 'project');
    mkdirSync(project);
    for (const name of ISOLATED_ENV) {
      const relative = name === 'HOME' || name === 'USERPROFILE' ? 'home'
        : name === 'OPENHUMAN_HOME' ? 'home/.openhuman' : name.toLowerCase();
      const dir = join(tempRoot, relative);
      mkdirSync(dir, { recursive: true });
      vi.stubEnv(name, dir);
    }
    for (const name of UNSET_ENV) vi.stubEnv(name, undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves existing removal candidates, discovery paths, and user registry roots', async () => {
    vi.resetModules();
    const { candidateDeployedPaths } = await import('../../../../src/extensions/project-local-remove.js');
    const { getProviderArtifactPathStrings, getProviderContextDiscoveryPathStrings, getProviderKernelSkillPath } =
      await import('../../../../src/providers/provider-definitions.js');
    const { USER_SCOPE_PATHS } = await import('../../../../src/cli/scope-resolver.js');
    const { recordUserDeploy, userRegistryPath } = await import('../../../../src/config/user-registry.js');
    const { resolveIndexDir } = await import('../../../../src/artifacts/index-reader.js');
    const { removeHandler } = await import('../../../../src/cli/handlers/subcommands.js');
    const home = process.env.HOME!;
    const expected = {
      openclaw: { artifact: join(home, '.openclaw/.aiwg/skills'), kernel: join(home, '.openclaw/skills/aiwg'), user: join(home, '.openclaw/skills') },
      muse: { artifact: '.agents/skills', kernel: '.agents/skills', user: join(process.env.XDG_CONFIG_HOME!, 'muse/skills') },
      openhuman: { artifact: join(home, '.openhuman/.aiwg/skills'), kernel: join(home, '.openhuman/skills'), user: join(home, '.openhuman/skills') },
      grokbot: { artifact: process.env.AIWG_GROKBOT_SKILLS_DIR!, kernel: '', user: process.env.AIWG_GROKBOT_SKILLS_DIR! },
      'grok-build': { artifact: '.grok/skills', kernel: '.grok/skills', user: join(process.env.GROK_HOME!, 'skills') },
    };
    for (const [provider, roots] of Object.entries(expected)) {
      expect(getProviderArtifactPathStrings(provider)?.skills).toBe(roots.artifact);
      expect(getProviderKernelSkillPath(provider)).toBe(roots.kernel);
      expect(getProviderContextDiscoveryPathStrings(provider)?.skills).toBe(provider === 'grokbot' ? '' : roots.artifact);
      expect(candidateDeployedPaths(project, provider, 'skills/legacy/SKILL.md')).toEqual([
        join(isAbsolute(roots.artifact) ? roots.artifact : join(project, roots.artifact), 'legacy/SKILL.md'),
      ]);
      expect(USER_SCOPE_PATHS[provider].skills).toBe(roots.user);
      await recordUserDeploy({ framework: 'legacy', provider, version: '1', source: 'bundled',
        counts: { agents: 0, commands: 0, skills: 1, rules: 0 }, entries: { skills: ['legacy'] } });
      const args = ['legacy', '--provider', provider, '--scope', 'user', '--dry-run'];
      const result = await removeHandler.execute({ cwd: project, frameworkRoot, rawArgs: ['remove', ...args], args });
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain(join(roots.user, 'legacy'));
    }
    expect(userRegistryPath()).toBe(join(home, '.aiwg/installed.json'));
    expect(resolveIndexDir(project, 'framework')).toBe(join(process.env.XDG_DATA_HOME!, 'aiwg/index/framework'));
  });

  for (const provider of PROVIDERS) {
    const title = `deploys decision-engine and support assets for ${provider}`;
    it(title, { timeout: 60000 }, async () => {
      await writeAiwgConfig(project, emptyConfig([provider]));
      vi.resetModules();
      const { useHandler } = await import('../../../../src/cli/handlers/use.js');
      const adapter = await import(`../../../../tools/agents/providers/${provider}.mjs`);
      // Grokbot exposes native writes only at user scope.
      const args = ['decision-engine', '--provider', provider, '--target', project,
        ...(provider === 'grokbot' ? ['--scope', 'user'] : [])];
      const result = await useHandler.execute({ cwd: project, frameworkRoot, rawArgs: ['use', ...args], args });
      expect(result.exitCode, result.message).toBe(0);

      const resolve = (value: string) => isAbsolute(value) ? value : join(project, value);
      let kernelRoot = resolve(adapter.kernelSkillsPath);
      let skillRoot = resolve(adapter.paths.skills);
      if (provider === 'muse') {
        // muse.mjs deploySkills: private STANDARD_MIRROR_SUBDIR at project scope.
        skillRoot = join(project, '.agents/.aiwg/skills');
      } else if (provider === 'grok-build') {
        skillRoot = resolve(adapter.standardSkillsPath);
      } else if (provider === 'grokbot') {
        // grokbot.mjs deploySkills: configured native root and its opt-in mirror.
        kernelRoot = adapter.resolveGrokbotSkillsDir();
        skillRoot = join(kernelRoot, '.aiwg', 'skills');
      } else if (provider === 'openclaw') {
        // openclaw.mjs deploySkills preserves the native aiwg/ namespace.
        kernelRoot = join(kernelRoot, 'aiwg');
      }
      const utilsSource = join(frameworkRoot, 'agentic/code/addons/aiwg-utils/skills/sess-probe');
      expect(readFileSync(join(skillRoot, 'sess-probe/SKILL.md'), 'utf8')).toContain('synthetic session probe');
      for (const support of ['session-entry.md', 'references/recipes.md']) {
        expect(readFileSync(join(skillRoot, 'sess-probe', support))).toEqual(readFileSync(join(utilsSource, support)));
      }
      expect(existsSync(join(skillRoot, 'de-check/SKILL.md'))).toBe(true);
      expect(existsSync(join(kernelRoot, 'kern-probe/SKILL.md'))).toBe(true);
      expect(readFileSync(join(kernelRoot, 'kern-probe/kernel-entry.md'), 'utf8')).toBe('# kernel entrypoint\n');
      expect((await readAiwgConfig(project))?.installed?.['decision-engine']).toBeDefined();
      if (provider === 'openclaw' || provider === 'grokbot') {
        const { readUserRegistry } = await import('../../../../src/config/user-registry.js');
        const record = (await readUserRegistry()).installed['decision-engine'].deployedTo[provider];
        expect(record.skills).toBe(1);
        expect(record).toMatchObject({ entries: { skills: [provider === 'openclaw'
          ? '../.aiwg/skills/de-check' : '.aiwg/skills/de-check'] } });
      }
      if (provider === 'openclaw' || provider === 'openhuman') {
        expect(existsSync(join(project, 'WORKSPACE.md'))).toBe(true);
        expect(existsSync(join(project, '.aiwg/AIWG.md'))).toBe(true);
        expect(existsSync(join(project, 'AIWG.md'))).toBe(false);
        expect(result.message).not.toContain('Required canonical context file is missing: AIWG.md');
      }
      expect(process.env.AIWG_ROOT).toBeUndefined();
      expect(process.env.AIWG_HOME).toBeUndefined();
    });
  }

  it('cleans removed standard skills and bundle-root support files on addon redeploy', { timeout: 60000 }, async () => {
    const sourceRoot = join(tempRoot, 'sources');
    writeSources(sourceRoot);
    const addon = join(sourceRoot, 'agentic/code/addons/decision-engine');
    write(addon, 'skills/retired/SKILL.md', '---\nname: retired\nplatforms: [all]\n---\nRetired.\n');
    write(addon, 'skills/de-check/SKILL.md',
      '---\nname: de-check\nplatforms: [all]\n---\nUse [single](templates/retired.md) and [pack](assets/reports/).\n');
    write(addon, 'templates/retired.md', '# retired template\n');
    write(addon, 'assets/reports/retired.md', '# retired report\n');
    await writeAiwgConfig(project, emptyConfig(['pi']));
    vi.resetModules();
    const { useHandler } = await import('../../../../src/cli/handlers/use.js');
    const args = ['decision-engine', '--provider', 'pi', '--target', project];
    const execute = () => useHandler.execute({ cwd: project, frameworkRoot: sourceRoot, rawArgs: ['use', ...args], args });
    const first = await execute();
    expect(first.exitCode, first.message).toBe(0);
    const deployed = join(project, '.pi/.aiwg/skills');
    expect(existsSync(join(deployed, 'de-check/templates/retired.md'))).toBe(true);
    expect(existsSync(join(deployed, 'de-check/assets/reports/retired.md'))).toBe(true);
    write(deployed, 'retired/local.txt', 'operator note');
    write(deployed, 'de-check/assets/reports/local.txt', 'operator report');
    rmSync(join(addon, 'skills/retired'), { recursive: true });
    rmSync(join(addon, 'templates'), { recursive: true });
    rmSync(join(addon, 'assets'), { recursive: true });
    write(addon, 'skills/de-check/SKILL.md', '---\nname: de-check\nplatforms: [all]\n---\nUpdated.\n');
    const second = await execute();
    expect(second.exitCode, second.message).toBe(0);
    expect(existsSync(join(deployed, 'retired/SKILL.md'))).toBe(false);
    expect(existsSync(join(deployed, 'de-check/templates/retired.md'))).toBe(false);
    expect(existsSync(join(deployed, 'de-check/assets/reports/retired.md'))).toBe(false);
    expect(readFileSync(join(deployed, 'retired/local.txt'), 'utf8')).toBe('operator note');
    expect(readFileSync(join(deployed, 'de-check/assets/reports/local.txt'), 'utf8')).toBe('operator report');
    expect(existsSync(join(deployed, 'sess-probe/SKILL.md'))).toBe(true);
  });


  it.each(['pi', 'openclaw', 'grokbot'])('keeps the first skill owner and support assets when a later addon collides for %s', { timeout: 60000 }, async provider => {
    const sourceRoot = join(tempRoot, 'sources');
    writeSources(sourceRoot);
    const addons = 'agentic/code/addons';
    write(sourceRoot, `${addons}/decision-engine/skills/sess-probe/SKILL.md`,
      '---\nname: sess-probe\nplatforms: [all]\nmetadata:\n  entrypoint: session-entry.md\n---\nConflicting skill.\n');
    write(sourceRoot, `${addons}/decision-engine/skills/sess-probe/session-entry.md`, '# conflicting entrypoint\n');
    await writeAiwgConfig(project, emptyConfig([provider]));
    vi.resetModules();
    const { useHandler } = await import('../../../../src/cli/handlers/use.js');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const args = ['decision-engine', '--provider', provider, '--target', project,
        ...(provider === 'grokbot' ? ['--scope', 'user'] : [])];
      const result = await useHandler.execute({ cwd: project, frameworkRoot: sourceRoot, rawArgs: ['use', ...args], args });
      expect(result.exitCode, result.message).toBe(0);
      const skillRoot = provider === 'openclaw' ? join(process.env.HOME!, '.openclaw/.aiwg/skills')
        : provider === 'grokbot' ? join(process.env.AIWG_GROKBOT_SKILLS_DIR!, '.aiwg/skills')
          : join(project, '.pi/.aiwg/skills');
      const deployed = join(skillRoot, 'sess-probe');
      expect(readFileSync(join(deployed, 'SKILL.md'), 'utf8')).toContain('synthetic session probe');
      expect(readFileSync(join(deployed, 'session-entry.md'), 'utf8')).toBe('# synthetic entrypoint\n');
      expect(warning).toHaveBeenCalledWith(
        "Skill deploy collision: 'sess-probe' is owned by aiwg-utils; decision-engine skipped",
      );
      expect(JSON.parse(readFileSync(join(deployed, '.aiwg-manifest.json'), 'utf8')).managed['SKILL.md'].frameworkSlug).toBe('aiwg-utils');
      if (provider !== 'pi') {
        const { readUserRegistry } = await import('../../../../src/config/user-registry.js');
        expect((await readUserRegistry()).installed['decision-engine'].deployedTo[provider]).toMatchObject({
          skills: 1, entries: { skills: [provider === 'openclaw' ? '../.aiwg/skills/de-check' : '.aiwg/skills/de-check'] },
        });
      }
    } finally {
      warning.mockRestore();
    }
  });

});
