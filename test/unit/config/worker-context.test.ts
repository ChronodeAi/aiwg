/**
 * Unit tests for the worker AIWG context provider union and launch-time
 * bootstrap ensure (#3685 round 2, T-OG-04).
 *
 * All fixtures are synthetic: plain config-shaped objects, tmpdir
 * workdirs, and injected deploy/status/skip fns. No model calls, no
 * network, no real HOME writes.
 *
 * @source @src/config/worker-context.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildWorkerContextDeployArgs,
  ensureWorkerContextBootstrap,
  flagDeployDirtiedSkipWorktree,
  mapCliToProviderId,
  resolveWorkerContextProvidersFromConfig,
  syncWorkerContextProviders,
  validateExplicitWorkerContextProviders,
  WorkerContextBootstrapError,
  workerContextBootstrapStatus,
} from '../../../src/config/worker-context.js';
import { emptyConfig, readAiwgConfig, writeAiwgConfig } from '../../../src/config/aiwg-config.js';
import { getProviderDefinition } from '../../../src/providers/provider-definitions.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function emptyDir(prefix = 'aiwg-worker-context-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

describe('validateExplicitWorkerContextProviders', () => {
  it('dedupes an explicit list', () => {
    expect(validateExplicitWorkerContextProviders(['codex', 'muse', 'codex'])).toEqual(['codex', 'muse']);
  });

  it('rejects empty, non-array, and hostile entries', () => {
    expect(() => validateExplicitWorkerContextProviders([])).toThrow(WorkerContextBootstrapError);
    expect(() => validateExplicitWorkerContextProviders('muse')).toThrow(WorkerContextBootstrapError);
    expect(() => validateExplicitWorkerContextProviders(['a,b'])).toThrow(WorkerContextBootstrapError);
    expect(() => validateExplicitWorkerContextProviders(['ok', 'nul\0x'])).toThrow(WorkerContextBootstrapError);
  });
});

describe('mapCliToProviderId: orchestration CLI to registry provider', () => {
  it('maps providers:<id> adapters and defaults bare CLI ids to providers:<cli>', () => {
    expect(mapCliToProviderId('codex', { clis: { codex: { adapter: 'providers:codex' } } }))
      .toEqual({ provider: 'codex' });
    expect(mapCliToProviderId('codex', null)).toEqual({ provider: 'codex' });
    expect(mapCliToProviderId('codex')).toEqual({ provider: 'codex' });
  });

  it('skips non-provider adapters and reports them', () => {
    expect(mapCliToProviderId('local', { clis: { local: { adapter: 'workerAdapters:local-http' } } }))
      .toEqual({ skipped: 'clis/local: workerAdapters:local-http' });
  });

  it('skips unknown provider ids and empty references', () => {
    expect(mapCliToProviderId('nope', { clis: { nope: { adapter: 'providers:nope' } } }))
      .toEqual({ skipped: 'clis/nope: providers:nope (unknown provider)' });
    expect(mapCliToProviderId('', null)).toEqual({ skipped: 'empty CLI reference' });
  });

  it.each([null, undefined, {}, { adapter: '' }, { adapter: 42 }])(
    'defaults an absent or unusable adapter entry %j to the CLI provider', entry => {
      expect(mapCliToProviderId('codex', { clis: { codex: entry } })).toEqual({ provider: 'codex' });
    },
  );

  it('reports malformed adapter references verbatim instead of guessing a provider', () => {
    expect(mapCliToProviderId('codex', { clis: { codex: { adapter: 'providers:codex,claude' } } }))
      .toEqual({ skipped: 'clis/codex: providers:codex,claude' });
    expect(mapCliToProviderId(42)).toEqual({ skipped: 'empty CLI reference' });
  });
});

describe('resolveWorkerContextProvidersFromConfig: union of providers and orchestration CLIs', () => {
  it('unions config providers, clis keys/adapters, and group member clis', () => {
    expect(resolveWorkerContextProvidersFromConfig({
      providers: ['muse'],
      parallelism: {
        clis: {
          codex: { adapter: 'providers:codex' },
          muse: { adapter: 'providers:muse' },
        },
        groups: {
          harness: { members: [{ cli: 'codex' }] },
          other: { members: [{ cli: 'claude' }] },
        },
      },
    })).toEqual({ providers: ['muse', 'codex', 'claude'], skipped: [] });
  });

  it('skips workerAdapters entries and reports which were skipped', () => {
    expect(resolveWorkerContextProvidersFromConfig({
      providers: ['muse'],
      parallelism: {
        clis: { local: { adapter: 'workerAdapters:local-http' } },
        groups: {},
      },
    })).toEqual({ providers: ['muse'], skipped: ['clis/local: workerAdapters:local-http'] });
  });

  it('keeps unknown configured provider ids verbatim for the deployer (project-local adapters)', () => {
    expect(resolveWorkerContextProvidersFromConfig({ providers: ['my-custom'] }))
      .toEqual({ providers: ['my-custom'], skipped: [] });
  });

  it('fails closed when the union is empty', () => {
    expect(() => resolveWorkerContextProvidersFromConfig(null)).toThrow(WorkerContextBootstrapError);
    expect(() => resolveWorkerContextProvidersFromConfig({})).toThrow(WorkerContextBootstrapError);
    expect(() => resolveWorkerContextProvidersFromConfig({ providers: [], parallelism: {} }))
      .toThrow(/union.*is empty/);
  });

  it('normalizes aliases, ignores unusable configured entries, and dedupes the union in order', () => {
    expect(resolveWorkerContextProvidersFromConfig({
      providers: [null, 42, '', ' OpenAI ', 'codex', 'project-local'],
      parallelism: { clis: { codex: null }, groups: { absent: null, empty: {} } },
    })).toEqual({ providers: ['codex', 'project-local'], skipped: [] });
  });

  it('reports group-only non-provider and missing CLI entries once per diagnostic', () => {
    expect(resolveWorkerContextProvidersFromConfig({
      providers: ['muse'],
      parallelism: {
        clis: { local: { adapter: 'workerAdapters:local-http' } },
        groups: { offline: { members: [{ cli: 'local' }, { cli: 'local' }, {}, { cli: '' }, { cli: 7 }] } },
      },
    })).toEqual({ providers: ['muse'], skipped: [
      'clis/local: workerAdapters:local-http',
      "groups/offline/members cli 'local': clis/local: workerAdapters:local-http",
      'groups/offline/members: empty CLI reference',
    ] });
  });

  it('includes skipped adapters in an empty-union refusal and its remedy', () => {
    expect(() => resolveWorkerContextProvidersFromConfig({
      providers: 'muse', parallelism: { groups: { offline: { members: [{ cli: 'unknown' }] } } },
    })).toThrow(expect.objectContaining({
      code: 'OG_WORKER_CONTEXT_UNAVAILABLE',
      message: expect.stringContaining("groups/offline/members cli 'unknown': clis/unknown: providers:unknown (unknown provider)"),
      remedy: expect.stringContaining('configure providers'),
    }));
  });
});

describe('workerContextBootstrapStatus: provider files plus AGENTS.md sections', () => {
  it('reports every missing piece in an empty workdir', () => {
    const dir = emptyDir();
    const status = workerContextBootstrapStatus({ workdir: dir, provider: 'muse' });
    expect(status.present).toBe(false);
    expect(status.missing).toContain("provider dir '.agents/skills'");
    // muse's contract targets AGENTS.md, so sections are required too.
    expect(getProviderDefinition('muse')?.context.bootstrapTargets).toContain('AGENTS.md');
    expect(status.missing).toContain('AGENTS.md rule sections');
  });

  it('is present once kernel dirs are non-empty and AGENTS.md carries markers', () => {
    const dir = emptyDir();
    mkdirSync(path.join(dir, '.agents', 'skills'), { recursive: true });
    writeFileSync(path.join(dir, '.agents', 'skills', 'kernel.md'), 'kernel\n');
    writeFileSync(path.join(dir, 'AGENTS.md'), '# AGENTS.md\n<!-- AIWG:rule-startup:start -->\nx\n<!-- AIWG:rule-startup:end -->\n');
    expect(workerContextBootstrapStatus({ workdir: dir, provider: 'muse' })).toEqual({ present: true, missing: [] });
  });

  it('still reports missing sections when dirs exist but AGENTS.md has no markers', () => {
    const dir = emptyDir();
    mkdirSync(path.join(dir, '.agents', 'skills'), { recursive: true });
    writeFileSync(path.join(dir, '.agents', 'skills', 'kernel.md'), 'kernel\n');
    writeFileSync(path.join(dir, 'AGENTS.md'), '# AGENTS.md\nno managed sections\n');
    const status = workerContextBootstrapStatus({ workdir: dir, provider: 'muse' });
    expect(status).toEqual({ present: false, missing: ['AGENTS.md rule sections'] });
  });

  it('reports an unknown provider as missing, never present', () => {
    expect(workerContextBootstrapStatus({ workdir: emptyDir(), provider: 'nope' }).present).toBe(false);
  });

  it('reports an empty kernel directory as missing', () => {
    const dir = emptyDir();
    mkdirSync(path.join(dir, '.agents/skills'), { recursive: true });
    writeFileSync(path.join(dir, 'AGENTS.md'), '<!-- AIWG:bootstrap:start -->');
    expect(workerContextBootstrapStatus({ workdir: dir, provider: 'muse' }))
      .toEqual({ present: false, missing: ["provider dir '.agents/skills'"] });
  });

  it('checks env-gated absolute artifact paths for providers without kernel directories', () => {
    const dir = emptyDir();
    const skills = path.join(dir, 'native-skills');
    mkdirSync(skills);
    writeFileSync(path.join(skills, 'kernel.md'), 'kernel');
    writeFileSync(path.join(dir, 'AGENTS.md'), '<!-- AIWG:bootstrap:start -->');
    vi.stubEnv('AIWG_GROKBOT_SKILLS_DIR', skills);
    try {
      expect(workerContextBootstrapStatus({ workdir: dir, provider: 'grokbot' }))
        .toEqual({ present: true, missing: [] });
    } finally { vi.unstubAllEnvs(); }
  });

  it('does not require AGENTS.md for providers whose bootstrap contract targets another file', () => {
    const dir = emptyDir();
    for (const subdir of ['.claude/skills', '.claude/rules', '.claude/hooks']) {
      mkdirSync(path.join(dir, subdir), { recursive: true });
      writeFileSync(path.join(dir, subdir, 'kernel.md'), 'kernel');
    }
    expect(workerContextBootstrapStatus({ workdir: dir, provider: 'claude' }))
      .toEqual({ present: true, missing: [] });
  });
});

describe('syncWorkerContextProviders: configured-provider path with an explicit list', () => {
  it('merges the union into the worktree config, preserving existing entries first', async () => {
    const dir = emptyDir();
    await writeAiwgConfig(dir, emptyConfig(['muse']));
    await expect(syncWorkerContextProviders({ workdir: dir, providers: ['muse', 'codex'] }))
      .resolves.toEqual({ providers: ['muse', 'codex'], updated: true });
    await expect(readAiwgConfig(dir)).resolves.toMatchObject({ providers: ['muse', 'codex'] });
  });

  it('creates a minimal config when the worktree has none', async () => {
    const dir = emptyDir();
    await expect(syncWorkerContextProviders({ workdir: dir, providers: ['codex'] }))
      .resolves.toEqual({ providers: ['codex'], updated: true });
    await expect(readAiwgConfig(dir)).resolves.toMatchObject({ providers: ['codex'] });
  });

  it('leaves an up-to-date config untouched', async () => {
    const dir = emptyDir();
    await writeAiwgConfig(dir, emptyConfig(['muse', 'codex']));
    let writes = 0;
    const outcome = await syncWorkerContextProviders({
      workdir: dir, providers: ['codex', 'muse'],
      writeConfig: async () => { writes += 1; },
    });
    expect(outcome).toEqual({ providers: ['muse', 'codex'], updated: false });
    expect(writes).toBe(0);
  });

  it('fails closed on an empty provider list', async () => {
    await expect(syncWorkerContextProviders({ workdir: emptyDir(), providers: [] }))
      .rejects.toThrow(WorkerContextBootstrapError);
  });
});

describe('buildWorkerContextDeployArgs: one pass, never one deploy per provider', () => {
  // --providers feeds only the global bootstrap and the orchestrated
  // verification report (src/cli/handlers/use.ts `executeCore` resolves
  // project-scope providers from config, ignoring both the flag and the
  // resolved-providers parameter). The supported project-scope mechanism
  // is the configured-provider path: sync the union into the worktree
  // config, then one `use all` pass with no --providers flag.
  it('renders a single aiwg use all invocation covering the configured set', () => {
    expect(buildWorkerContextDeployArgs({ providers: ['muse', 'codex', 'muse'], target: '/w' }))
      .toEqual(['use', 'all', '--target', '/w', '--yes']);
  });
});

describe('one-pass deploy through the real use handler: every provider, AGENTS.md intact', () => {
  it('sync plus a single `use all` pass deploys the whole union without clobbering rule sections', async () => {
    const dir = emptyDir('aiwg-worker-onepass-');
    const project = path.join(dir, 'wt');
    mkdirSync(project);
    for (const name of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'AIWG_CONFIG']) {
      const home = path.join(dir, name.toLowerCase());
      mkdirSync(home);
      vi.stubEnv(name, home);
    }
    for (const name of ['AIWG_ROOT', 'AIWG_HOME', 'AIWG_USER_REGISTRY_PATH', 'CODEX_HOME']) vi.stubEnv(name, undefined);
    try {
      // The worktree base predates the orchestration CLI: its config knows
      // only muse, while the union (config providers plus orchestration
      // CLIs) already includes codex.
      await writeAiwgConfig(project, emptyConfig(['muse']));
      const synced = await syncWorkerContextProviders({ workdir: project, providers: ['muse', 'codex'] });
      expect(synced).toEqual({ providers: ['muse', 'codex'], updated: true });

      vi.resetModules();
      const { UseHandler } = await import('../../../src/cli/handlers/use.js');
      const repoRoot = path.resolve(import.meta.dirname, '../../..');
      // Spawn argv (one child process) versus handler args (no command word).
      const argv = buildWorkerContextDeployArgs({ providers: synced.providers, target: project });
      expect(argv[0]).toBe('use');
      const handlerArgs = argv.slice(1);
      const result = await new UseHandler().execute({
        cwd: project, frameworkRoot: repoRoot, rawArgs: ['use', ...handlerArgs], args: handlerArgs,
      });
      expect(result.exitCode, result.message).toBe(0);
      for (const provider of ['muse', 'codex']) {
        expect(workerContextBootstrapStatus({ workdir: project, provider }),
          `${provider} bootstrap missing after one pass`).toEqual({ present: true, missing: [] });
      }
      const agentsMd = readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
      expect(agentsMd).toMatch(/<!--\s*AIWG:[A-Za-z0-9_-]+:start\s*-->/);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 240000);
});

describe('ensureWorkerContextBootstrap: no-op when present, one pass when missing, typed refusal when impossible', () => {
  function presentWorkdir() {
    const dir = emptyDir();
    mkdirSync(path.join(dir, '.agents', 'skills'), { recursive: true });
    writeFileSync(path.join(dir, '.agents', 'skills', 'kernel.md'), 'kernel\n');
    writeFileSync(path.join(dir, 'AGENTS.md'), '<!-- AIWG:rule-startup:start -->\nx\n<!-- AIWG:rule-startup:end -->\n');
    return dir;
  }

  it('does not deploy when the bootstrap is already present', async () => {
    const deployFn = () => { throw new Error('must not deploy when present'); };
    await expect(ensureWorkerContextBootstrap({ workdir: presentWorkdir(), provider: 'muse', deployFn }))
      .resolves.toEqual({ ensured: false, providers: ['muse'], skippedBridges: [] });
  });

  it('deploys once into the workdir and re-verifies, flagging tracked bridges', async () => {
    const dir = emptyDir();
    const seen: Array<{ worktreePath: string; providers: string[] }> = [];
    const outcome = await ensureWorkerContextBootstrap({
      workdir: dir,
      provider: 'muse',
      providers: ['muse', 'codex'],
      deployFn: ({ worktreePath, providers }) => {
        seen.push({ worktreePath, providers: [...providers] });
        mkdirSync(path.join(worktreePath, '.agents', 'skills'), { recursive: true });
        writeFileSync(path.join(worktreePath, '.agents', 'skills', 'kernel.md'), 'kernel\n');
        writeFileSync(path.join(worktreePath, 'AGENTS.md'), '<!-- AIWG:rule-startup:start -->\nx\n<!-- AIWG:rule-startup:end -->\n');
        return { providers: [...providers] };
      },
      skipWorktreeFn: () => ['AGENTS.md'],
    });
    expect(seen).toEqual([{ worktreePath: dir, providers: ['muse', 'codex'] }]);
    expect(outcome).toEqual({ ensured: true, providers: ['muse', 'codex'], skippedBridges: ['AGENTS.md'] });
  });

  it('syncs the union into the workdir config before deploying', async () => {
    const dir = emptyDir();
    await writeAiwgConfig(dir, emptyConfig(['muse']));
    await ensureWorkerContextBootstrap({
      workdir: dir, provider: 'muse', providers: ['muse', 'codex'],
      deployFn: ({ worktreePath, providers }) => {
        mkdirSync(path.join(worktreePath, '.agents', 'skills'), { recursive: true });
        writeFileSync(path.join(worktreePath, '.agents', 'skills', 'kernel.md'), 'kernel\n');
        writeFileSync(path.join(worktreePath, 'AGENTS.md'), '<!-- AIWG:rule-startup:start -->\nx\n<!-- AIWG:rule-startup:end -->\n');
        return { providers: [...providers] };
      },
      skipWorktreeFn: () => [],
    });
    await expect(readAiwgConfig(dir)).resolves.toMatchObject({ providers: ['muse', 'codex'] });
  });

  it('refuses with a typed diagnostic naming the remedy when the deploy fails', async () => {
    const dir = emptyDir();
    const error = await ensureWorkerContextBootstrap({
      workdir: dir, provider: 'muse',
      deployFn: () => { throw new Error('disk is on fire'); },
    }).then(() => { throw new Error('must have thrown'); }, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkerContextBootstrapError);
    expect((error as WorkerContextBootstrapError).code).toBe('OG_WORKER_CONTEXT_UNAVAILABLE');
    expect((error as WorkerContextBootstrapError).remedy).toMatch(/aiwg use all/);
  });

  it('refuses when the deploy succeeds but the bootstrap is still missing', async () => {
    const dir = emptyDir();
    await expect(ensureWorkerContextBootstrap({
      workdir: dir, provider: 'muse', deployFn: ({ providers }) => ({ providers: [...providers] }),
    })).rejects.toThrow(/still missing/);
  });

  it('refuses a missing workdir and never deploys outside the workdir', async () => {
    await expect(ensureWorkerContextBootstrap({ workdir: '/nonexistent-aiwg-test-dir', provider: 'muse' }))
      .rejects.toThrow(/existing absolute workdir/);
    const dir = emptyDir();
    await expect(ensureWorkerContextBootstrap({
      workdir: dir, provider: 'muse',
      deployFn: ({ worktreePath }) => ({ providers: [worktreePath] }),
      statusFn: () => ({ present: false, missing: ['x'] }),
    })).rejects.toThrow();
  });
});

describe('flagDeployDirtiedSkipWorktree: deploy-touched tracked bridges leave the worker diff', () => {
  function git(cwd: string, args: string[]) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return String(result.stdout ?? '').trim();
  }

  it('flags deploy-dirtied tracked files so git status hides them', () => {
    const dir = emptyDir('aiwg-skipwt-');
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 't@example.test']);
    git(dir, ['config', 'user.name', 'T']);
    writeFileSync(path.join(dir, 'AGENTS.md'), 'base\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'base']);
    writeFileSync(path.join(dir, 'AGENTS.md'), 'base\n<!-- AIWG:x:start -->\n');

    expect(flagDeployDirtiedSkipWorktree({ workdir: dir })).toEqual(['AGENTS.md']);
    expect(git(dir, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
    expect(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('AIWG:x:start');
  });

  it('throws outside a git repository so the caller can skip silently', () => {
    expect(() => flagDeployDirtiedSkipWorktree({ workdir: emptyDir('aiwg-nogit-') })).toThrow();
  });
});
