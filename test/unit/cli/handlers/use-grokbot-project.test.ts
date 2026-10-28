/** #3648: project-scope grokbot is bridge-only — deploys succeed with zero native artifacts. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileWithCapture as execFileSync } from '../../../helpers/exec-file-capture.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyConfig, readAiwgConfig, writeAiwgConfig } from '../../../../src/config/aiwg-config.js';

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '../../../..');

// Exercise the checkout's deployer while use resolves tiny synthetic addons.
vi.mock('../../../../src/cli/handlers/script-runner.js', () => ({
  createScriptRunner: (sourceRoot: string) => ({
    run: async (script: string, args: string[] = []) => {
      try {
        if (!args.includes('--source')) args = [...args, '--source', sourceRoot];
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

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => process.env.HOME!;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('../../../../src/channel/manager.mjs', () => ({
  getFrameworkRoot: vi.fn(async () => 'mock-framework-root'),
  getVersionInfo: vi.fn(async () => ({ version: 'test', channel: 'test', devMode: true })),
}));

function write(root: string, relative: string, content: string): void {
  const destination = join(root, relative);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function writeSources(root: string): void {
  mkdirSync(join(root, 'agentic/code/frameworks'), { recursive: true });
  write(root, 'agentic/code/providers/model-catalog.v1.json', JSON.stringify({
    version: '1.0.0', refreshedAt: '2026-10-12',
    providers: { grokbot: { roles: {} } },
  }));
  const addons = 'agentic/code/addons';
  write(root, `${addons}/aiwg-utils/manifest.json`, JSON.stringify({ id: 'aiwg-utils', version: '1.0.0' }));
  write(root, `${addons}/aiwg-utils/skills/kern-probe/SKILL.md`,
    '---\nnamespace: aiwg\nname: kern-probe\nplatforms: [all]\nkernel: true\ndescription: synthetic kernel probe\n---\n\nKernel probe.\n');
  write(root, `${addons}/decision-engine/manifest.json`, JSON.stringify({
    id: 'decision-engine', version: '1.0.0', explicitInstall: true,
  }));
  write(root, `${addons}/decision-engine/skills/de-check/SKILL.md`,
    '---\nnamespace: aiwg\nname: de-check\nplatforms: [all]\ndescription: synthetic decision check\n---\n\nCheck body.\n');
  write(root, `${addons}/decision-engine/rules/de-rule.md`,
    '---\nactivation: core\n---\nDecision rule.\n');
}

describe('grokbot project-scope bridge-only deploy (#3648)', () => {
  let frameworkRoot: string;
  let tempRoot: string;
  let project: string;

  beforeEach(async () => {
    frameworkRoot = mkdtempSync(join(tmpdir(), 'aiwg-grokbot-use-sources-'));
    writeSources(frameworkRoot);
    tempRoot = mkdtempSync(join(tmpdir(), 'aiwg-grokbot-use-'));
    project = join(tempRoot, 'project');
    mkdirSync(project);
    for (const name of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
      const dir = join(tempRoot, name.toLowerCase());
      mkdirSync(dir, { recursive: true });
      vi.stubEnv(name, dir);
    }
    for (const name of ['AIWG_ROOT', 'AIWG_HOME', 'AIWG_USER_REGISTRY_PATH', 'AIWG_GROKBOT_SKILLS_DIR']) {
      vi.stubEnv(name, undefined);
    }
    delete process.env.AIWG_GROKBOT_SKILLS_DIR;
    await writeAiwgConfig(project, emptyConfig(['grokbot']));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(frameworkRoot, { recursive: true, force: true });
  });

  async function use(args: string[]) {
    vi.resetModules();
    const { useHandler } = await import('../../../../src/cli/handlers/use.js');
    return useHandler.execute({ cwd: project, frameworkRoot, rawArgs: ['use', ...args], args });
  }

  it('deploys decision-engine with zero native artifacts recorded', { timeout: 120_000 }, async () => {
    const result = await use(['decision-engine', '--provider', 'grokbot', '--target', project]);
    expect(result.exitCode, result.message).toBe(0);
    const config = (await readAiwgConfig(project))!;
    expect(config.installed['decision-engine'].deployedTo.grokbot).toMatchObject({
      agents: 0, commands: 0, skills: 0, rules: 0,
    });
    // Bridge-only: no native skill copies, no invented home roots.
    expect(existsSync(join(project, '.cursor'))).toBe(false);
  });

  it('keeps the status probe healthy and doctor finding-free after the deploy', { timeout: 120_000 }, async () => {
    const deployed = await use(['decision-engine', '--provider', 'grokbot', '--target', project]);
    expect(deployed.exitCode, deployed.message).toBe(0);
    vi.resetModules();
    const { buildDeploymentStatusProbe, verifyConfiguredDeployments } =
      await import('../../../../src/cli/services/deployment-verification.js');
    const probe = await buildDeploymentStatusProbe(project, frameworkRoot,
      { provider: 'grokbot', bundle: 'decision-engine' }) as {
      status: string; checks: { malformed_config: boolean };
    };
    expect(probe.status).not.toBe('needs-repair');
    expect(probe.checks.malformed_config).toBe(false);
    const doctor = await verifyConfiguredDeployments(project,
      { provider: 'grokbot', bundle: 'decision-engine' }, frameworkRoot);
    expect(doctor.findings.filter(finding => finding.severity === 'blocking')).toEqual([]);
  });

  it('deploys all without a getter crash and records zero native artifacts', { timeout: 180_000 }, async () => {
    const result = await use(['all', '--provider', 'grokbot', '--target', project]);
    expect(result.exitCode, result.message).toBe(0);
    expect(String(result.message ?? '')).not.toContain('only a getter');
    const config = (await readAiwgConfig(project))!;
    expect(config.installed['all'].deployedTo.grokbot).toMatchObject({
      agents: 0, commands: 0, skills: 0, rules: 0,
    });
  });
});
