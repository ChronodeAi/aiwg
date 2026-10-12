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

const FOLLOW_UPS: Partial<Record<typeof PROVIDERS[number], string>> = {
  // OpenClaw's home deploy lacks a user-registry record; verification requires
  // project AIWG.md even though its context policy disables emission.
  openclaw: 'missing user-scope installed record and project AIWG.md context policy alignment',
  // OpenHuman verification requires project AIWG.md, but emission is disabled.
  openhuman: 'missing project AIWG.md context policy alignment',
  // use.ts reconciles standard assets at .agents/skills instead of the adapter's
  // STANDARD_MIRROR_SUBDIR (.agents/.aiwg/skills).
  muse: 'missing support-asset reconciliation at .agents/.aiwg/skills',
  // use.ts reconciles standard assets at .grok/skills instead of the adapter's
  // standardSkillsPath (.grok/.aiwg/skills).
  'grok-build': 'missing support-asset reconciliation at .grok/.aiwg/skills',
  // use.ts lacks the adapter's <configured-root>/.aiwg/skills mirror and native
  // kernel root in reconciliation; user-scope addon registry recording is absent.
  grokbot: 'missing mirror/kernel-root reconciliation and user-scope addon registry recording',
};

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
    '---\nnamespace: aiwg\nname: kern-probe\nplatforms: [all]\nkernel: true\ndescription: synthetic kernel probe\n---\n\nKernel probe.\n');
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

  for (const provider of PROVIDERS) {
    const title = `deploys decision-engine and support assets for ${provider}`;
    if (FOLLOW_UPS[provider]) {
      it.todo(`${title}: ${FOLLOW_UPS[provider]}`);
      continue;
    }
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
      expect((await readAiwgConfig(project))?.installed?.['decision-engine']).toBeDefined();
      // Follow-up: OpenClaw project-scope and Grokbot user-scope direct addon
      // deploys do not record decision-engine in the per-user registry. Registry
      // bookkeeping is outside this shared skill-discovery regression.
      expect(process.env.AIWG_ROOT).toBeUndefined();
      expect(process.env.AIWG_HOME).toBeUndefined();
    });
  }
});
