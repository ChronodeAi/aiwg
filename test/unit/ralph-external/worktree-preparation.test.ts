/**
 * Unit/conformance tests for Tier 0 writer worktree preparation and
 * ownership (FR-OG-039, FR-OG-068, #2889 / B-OG-13).
 *
 * Uses real temporary git repositories and real `git worktree` invocations
 * (not mocked spawn) so the exact-base-digest binding and claim-conflict
 * refusal are proven against actual git behavior. T-OG-04 scope.
 *
 * @source @tools/ralph-external/lib/worktree-preparation.mjs
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  WorktreeClaimRegistry,
  forceOwnerOnlyDir,
  defaultDeployWorkerContext,
  prepareWorkerWorktree,
  releaseWorkerWorktree,
  resolveBaseDigest,
  resolveWorkerContextProviders,
  verifyWorkerContextSections,
} from '../../../tools/ralph-external/lib/worktree-preparation.mjs';
import { resolveWorkerContextProvidersFromConfig } from '../../../src/config/worker-context.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function tmpRepo() {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'aiwg-worktree-prep-repo-'));
  roots.push(repoRoot);
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.email', 'conductor@example.test']);
  git(repoRoot, ['config', 'user.name', 'Conductor']);
  writeFileSync(path.join(repoRoot, 'README.md'), 'base\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-q', '-m', 'base commit']);
  return repoRoot;
}

function tmpWorktreesRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwg-worktree-prep-worktrees-'));
  roots.push(root);
  return root;
}

describe('T-OG-04 worktree preparation argument and filesystem refusals', () => {
  it('rejects absent registries before calling git', async () => {
    await expect(prepareWorkerWorktree()).rejects.toThrow(/requires a WorktreeClaimRegistry/);
    expect(() => releaseWorkerWorktree()).toThrow(/requires a WorktreeClaimRegistry/);
  });

  it('rejects unusable claim owners, file paths and ports without retaining claims', () => {
    const registry = new WorktreeClaimRegistry();
    for (const owner of ['', undefined]) expect(() => registry.claim(owner, {})).toThrow(/ownerId/);
    for (const file of ['relative', undefined]) expect(() => registry.claim('owner', { files: [file] })).toThrow(/absolute/);
    for (const port of [0, -1, 1.5, 'invalid']) expect(() => registry.claim('owner', { ports: [port] })).toThrow(/positive integer/);
    expect(registry.list()).toEqual([]);
  });

  it('creates an owner-only directory through the compatibility entry and refuses files', () => {
    const root = tmpWorktreesRoot(), dir = path.join(root, 'private');
    expect(forceOwnerOnlyDir(dir)).toBe(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(forceOwnerOnlyDir(dir)).toBe(dir);
    const file = path.join(root, 'file'); writeFileSync(file, 'fixture');
    expect(() => forceOwnerOnlyDir(file)).toThrow(/not a directory/);
  });
});

describe('resolveBaseDigest binds an exact commit SHA, never a moving ref (T-OG-04)', () => {
  it('resolves HEAD to a 40-char SHA matching git rev-parse', () => {
    const repoRoot = tmpRepo();
    const expected = git(repoRoot, ['rev-parse', 'HEAD']);
    const digest = resolveBaseDigest({ repoRoot });
    expect(digest).toBe(expected);
    expect(digest).toMatch(/^[a-f0-9]{40}$/);
  });

  it('throws rather than returning a non-commit answer for an unresolvable revision', () => {
    const repoRoot = tmpRepo();
    expect(() => resolveBaseDigest({ repoRoot, revision: 'does-not-exist' })).toThrow();
  });
});

describe('WorktreeClaimRegistry: overlapping writer claims serialize or fail (T-OG-04)', () => {
  it('grants disjoint claims to different owners', () => {
    const registry = new WorktreeClaimRegistry();
    expect(registry.claim('w1', { files: ['/repo/a.ts'], ports: [9001] })).toMatchObject({ granted: true });
    expect(registry.claim('w2', { files: ['/repo/b.ts'], ports: [9002] })).toMatchObject({ granted: true });
  });

  it('refuses a second owner claiming a file another owner already holds, and grants nothing from that conflicting request', () => {
    const registry = new WorktreeClaimRegistry();
    registry.claim('w1', { files: ['/repo/shared.ts'] });
    const attempt = registry.claim('w2', { files: ['/repo/shared.ts'], ports: [9100] });
    expect(attempt.granted).toBe(false);
    expect(attempt.conflicts).toEqual([{ claim: 'file:/repo/shared.ts', heldBy: 'w1' }]);
    // The port in the same request was not granted either -- all-or-nothing.
    expect(registry.claim('w3', { ports: [9100] }).granted).toBe(true);
  });

  it('refuses a second owner claiming a port another owner already holds', () => {
    const registry = new WorktreeClaimRegistry();
    registry.claim('w1', { ports: [8080] });
    const attempt = registry.claim('w2', { ports: [8080] });
    expect(attempt).toMatchObject({ granted: false, conflicts: [{ claim: 'port:8080', heldBy: 'w1' }] });
  });

  it('allows an owner to re-claim its own held claims (idempotent), and frees them on release so a later owner can serialize in', () => {
    const registry = new WorktreeClaimRegistry();
    registry.claim('w1', { files: ['/repo/a.ts'] });
    expect(registry.claim('w1', { files: ['/repo/a.ts'] }).granted).toBe(true);
    expect(registry.claim('w2', { files: ['/repo/a.ts'] }).granted).toBe(false);
    registry.release('w1');
    expect(registry.list()).toEqual([]);
    expect(registry.claim('w2', { files: ['/repo/a.ts'] }).granted).toBe(true);
  });

  it('requires absolute file claim paths so claims cannot depend on the conductor process cwd', () => {
    const registry = new WorktreeClaimRegistry();
    expect(() => registry.claim('w1', { files: ['relative.ts'] })).toThrow(/absolute/);
  });
});

describe('prepareWorkerWorktree: conductor-owned worktree creation bound to an exact base digest (T-OG-04)', () => {
  it('creates a worktree at the exact resolved base digest and records conductor ownership', async () => {
    const repoRoot = tmpRepo();
    const worktreesRoot = tmpWorktreesRoot();
    const registry = new WorktreeClaimRegistry();
    const expected = git(repoRoot, ['rev-parse', 'HEAD']);

    const outcome = await prepareWorkerWorktree({
      repoRoot, ownerId: 'writer-1', name: 'alpha',
      claims: { files: [path.join(repoRoot, 'README.md')] },
      registry, worktreesRoot, deployContext: false,
    });

    expect(outcome.created).toBe(true);
    expect(outcome.baseDigest).toBe(expected);
    expect(existsSync(outcome.path!)).toBe(true);
    expect(readFileSync(path.join(outcome.path!, 'README.md'), 'utf8')).toBe('base\n');
    // git worktree list proves it is a real, registered worktree of this repo.
    expect(git(repoRoot, ['worktree', 'list'])).toContain(outcome.path);
  });

  it('M5: the created worktree directory is 0700, independent of the process umask (not left group/other-readable)', async context => {
    if (process.getuid?.() === 0) { context.skip('running as root: permission bits are not meaningfully enforced/observable the same way'); return; }
    const repoRoot = tmpRepo();
    const worktreesRoot = tmpWorktreesRoot();
    const registry = new WorktreeClaimRegistry();

    const outcome = await prepareWorkerWorktree({ repoRoot, ownerId: 'writer-1', name: 'alpha', claims: {}, registry, worktreesRoot, deployContext: false });

    const mode = statSync(outcome.path!).mode & 0o777;
    expect(mode).toBe(0o700);
    const rootMode = statSync(worktreesRoot).mode & 0o777;
    expect(rootMode).toBe(0o700);
  });

  it('blocks a second writer claiming the same file instead of creating a second worktree (serialize/fail, never silent overlap)', async () => {
    const repoRoot = tmpRepo();
    const worktreesRoot = tmpWorktreesRoot();
    const registry = new WorktreeClaimRegistry();
    const sharedFile = path.join(repoRoot, 'README.md');

    const first = await prepareWorkerWorktree({ repoRoot, ownerId: 'writer-1', name: 'alpha', claims: { files: [sharedFile] }, registry, worktreesRoot, deployContext: false });
    expect(first.created).toBe(true);

    const second = await prepareWorkerWorktree({ repoRoot, ownerId: 'writer-2', name: 'beta', claims: { files: [sharedFile] }, registry, worktreesRoot, deployContext: false });
    expect(second).toMatchObject({ created: false, blocked: true });
    // M4: the claim key is now `file:<realpath>#<dev>:<ino>`, not a bare
    // resolved path, so two spellings of the same inode always collide.
    expect(second.conflicts).toHaveLength(1);
    expect(second.conflicts[0]).toMatchObject({ heldBy: 'writer-1' });
    expect(second.conflicts[0].claim).toMatch(new RegExp(`^file:${sharedFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#\\d+:\\d+$`));
    // No second worktree directory was created for the blocked attempt.
    expect(git(repoRoot, ['worktree', 'list']).split('\n').length).toBe(2); // main + writer-1 only
  });

  it('M4: keys a file claim by realpath+dev:inode so a symlinked-ancestor spelling of the same file collides with the literal spelling', () => {
    const repoRoot = tmpRepo();
    const registry = new WorktreeClaimRegistry();
    const realFile = path.join(repoRoot, 'README.md');
    const aliasDir = mkdtempSync(path.join(tmpdir(), 'aiwg-worktree-prep-alias-'));
    roots.push(aliasDir);
    const aliasLink = path.join(aliasDir, 'repo-link');
    symlinkSync(repoRoot, aliasLink);
    const aliasFile = path.join(aliasLink, 'README.md');

    expect(registry.claim('w1', { files: [realFile] }).granted).toBe(true);
    const attempt = registry.claim('w2', { files: [aliasFile] });
    expect(attempt.granted).toBe(false);
    expect(attempt.conflicts).toHaveLength(1);
    expect(attempt.conflicts[0].heldBy).toBe('w1');
  });

  it('releases the claim it just took when git worktree add itself fails, so a failed preparation never leaks ownership', async () => {
    const repoRoot = tmpRepo();
    const worktreesRoot = tmpWorktreesRoot();
    const registry = new WorktreeClaimRegistry();
    const claimedFile = path.join(repoRoot, 'README.md');

    await expect(prepareWorkerWorktree({
      repoRoot, ownerId: 'writer-1', name: 'alpha', revision: 'no-such-revision',
      claims: { files: [claimedFile] }, registry, worktreesRoot, deployContext: false,
    })).rejects.toThrow();

    expect(registry.list()).toEqual([]);
    // The claim is free again for a different writer.
    expect(registry.claim('writer-2', { files: [claimedFile] }).granted).toBe(true);
  });
});

describe('releaseWorkerWorktree: dirty work is retained by default, never force-deleted (T-OG-04, T-OG-10)', () => {
  it('releases ownership bookkeeping but leaves the worktree and any dirty files on disk by default', async () => {
    const repoRoot = tmpRepo();
    const worktreesRoot = tmpWorktreesRoot();
    const registry = new WorktreeClaimRegistry();
    const prepared = await prepareWorkerWorktree({ repoRoot, ownerId: 'writer-1', name: 'alpha', claims: {}, registry, worktreesRoot, deployContext: false });
    writeFileSync(path.join(prepared.path!, 'dirty-work.txt'), 'uncommitted worker output\n');

    const released = releaseWorkerWorktree({ registry, ownerId: 'writer-1', repoRoot, worktreePath: prepared.path! });

    expect(released).toEqual({ removed: false, retained: true, path: prepared.path });
    expect(existsSync(prepared.path!)).toBe(true);
    expect(readFileSync(path.join(prepared.path!, 'dirty-work.txt'), 'utf8')).toBe('uncommitted worker output\n');
    expect(registry.list()).toEqual([]);
  });

  it('removes the worktree only on an explicit remove:true opt-in', async () => {
    const repoRoot = tmpRepo();
    const worktreesRoot = tmpWorktreesRoot();
    const registry = new WorktreeClaimRegistry();
    const prepared = await prepareWorkerWorktree({ repoRoot, ownerId: 'writer-1', name: 'alpha', claims: {}, registry, worktreesRoot, deployContext: false });

    const released = releaseWorkerWorktree({ registry, ownerId: 'writer-1', repoRoot, worktreePath: prepared.path!, remove: true });

    expect(released).toEqual({ removed: true, retained: false, path: prepared.path });
    expect(existsSync(prepared.path!)).toBe(false);
  });
});

describe('resolveWorkerContextProviders: explicit list wins, else the union of config providers and orchestration CLIs (#3685 round 2)', () => {
  const explodingReadConfig = async () => { throw new Error('config must not be read when an explicit list wins'); };
  const unionOf = (config: unknown) => resolveWorkerContextProviders({
    repoRoot: '/repo', readConfig: async () => config, resolveFromConfig: resolveWorkerContextProvidersFromConfig,
  });

  it('prefers an explicit list and dedupes it without reading any config', async () => {
    await expect(resolveWorkerContextProviders({ repoRoot: '/repo', providers: ['codex', 'muse', 'codex'], readConfig: explodingReadConfig }))
      .resolves.toEqual({ providers: ['codex', 'muse'], skipped: [] });
  });

  it('unions config providers with parallelism clis and group members through the registry', async () => {
    await expect(unionOf({
      providers: ['muse'],
      parallelism: {
        clis: {
          codex: { adapter: 'providers:codex', accountScope: 'local-account', quotaScope: 'codex-subscription' },
          muse: { adapter: 'providers:muse', accountScope: 'local-account', quotaScope: 'muse-subscription' },
        },
        groups: {
          harness: { members: [{ id: 'codex-luna', cli: 'codex', model: 'm', roles: ['efficiency'] }] },
          extra: { members: [{ id: 'x', cli: 'claude', model: 'm', roles: ['coding'] }] },
        },
      },
    })).resolves.toEqual({ providers: ['muse', 'codex', 'claude'], skipped: [] });
  });

  it('skips non-provider adapters such as workerAdapters:local-http and reports them', async () => {
    await expect(unionOf({
      providers: ['muse'],
      parallelism: {
        clis: { local: { adapter: 'workerAdapters:local-http', accountScope: 'x', quotaScope: 'y' } },
        groups: {},
      },
    })).resolves.toEqual({ providers: ['muse'], skipped: ['clis/local: workerAdapters:local-http'] });
  });

  it('fails closed when no providers are configured and none are given', async () => {
    await expect(resolveWorkerContextProviders({ repoRoot: '/repo', readConfig: async () => null }))
      .rejects.toThrow(/configured providers/);
    await expect(unionOf({ providers: [] })).rejects.toThrow(/configured providers/);
    await expect(unionOf({})).rejects.toThrow(/configured providers/);
    await expect(resolveWorkerContextProviders({ repoRoot: '/repo', providers: [], readConfig: explodingReadConfig }))
      .rejects.toThrow(/non-empty array/);
  });
});

describe('defaultDeployWorkerContext: sync plus exactly one aiwg use all pass (#3685 round 2)', () => {
  it('syncs the union into the worktree config, then covers every provider in a single invocation', async () => {
    const seen: Array<{ bin: string; argv: string[] }> = [];
    const fakeSpawn = ((bin: string, argv: string[]) => {
      seen.push({ bin, argv });
      return { status: 0, stdout: '', stderr: '' };
    }) as any;
    const synced: Array<{ worktreePath: string; providers: string[] }> = [];
    const syncFn = async (worktreePath: string, providers: string[]) => {
      synced.push({ worktreePath, providers: [...providers] });
      return { providers: [...providers], updated: true };
    };
    const argvFn = async (providers: string[], target: string) => ['use', 'all', '--target', target, '--yes'];
    await expect(defaultDeployWorkerContext({ worktreePath: '/w', providers: ['muse', 'codex'], aiwgBin: 'aiwg', spawn: fakeSpawn, syncFn, argvFn }))
      .resolves.toEqual({ providers: ['muse', 'codex'] });
    expect(synced).toEqual([{ worktreePath: '/w', providers: ['muse', 'codex'] }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ bin: 'aiwg', argv: ['use', 'all', '--target', '/w', '--yes'] });
  });

  it('fails closed when the single pass exits non-zero', async () => {
    const failing = (() => ({ status: 1, stdout: '', stderr: 'deploy broke' })) as any;
    const syncFn = async (_worktreePath: string, providers: string[]) => ({ providers: [...providers], updated: false });
    const argvFn = async (providers: string[], target: string) => ['use', 'all', '--target', target, '--yes'];
    await expect(defaultDeployWorkerContext({ worktreePath: '/w', providers: ['muse'], spawn: failing, syncFn, argvFn }))
      .rejects.toThrow(/exited 1.*deploy broke/);
  });

  it('fails closed on an empty provider list before spawning', async () => {
    const seen: Array<unknown> = [];
    const fakeSpawn = ((...args: unknown[]) => { seen.push(args); return { status: 0 }; }) as any;
    await expect(defaultDeployWorkerContext({ worktreePath: '/w', providers: [], spawn: fakeSpawn }))
      .rejects.toThrow(/non-empty provider list/);
    expect(seen).toHaveLength(0);
  });
});

describe('verifyWorkerContextSections: rule sections gate the launch (#3685)', () => {
  function emptyDir() {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiwg-context-verify-'));
    roots.push(dir);
    return dir;
  }

  it('rejects a missing AGENTS.md and one without rule markers', () => {
    const dir = emptyDir();
    expect(() => verifyWorkerContextSections({ worktreePath: dir, providers: ['muse'] })).toThrow(/AGENTS\.md.*missing/);
    writeFileSync(path.join(dir, 'AGENTS.md'), '# AGENTS.md\nno managed sections here\n');
    expect(() => verifyWorkerContextSections({ worktreePath: dir, providers: ['muse'] })).toThrow(/no AIWG rule sections/);
  });

  it('accepts an AGENTS.md carrying AIWG rule-section markers', () => {
    const dir = emptyDir();
    writeFileSync(path.join(dir, 'AGENTS.md'), '# AGENTS.md\n<!-- AIWG:rule-startup:start -->\nbody\n<!-- AIWG:rule-startup:end -->\n');
    expect(verifyWorkerContextSections({ worktreePath: dir, providers: ['muse'] })).toEqual({ verified: true, providers: ['muse'] });
  });
});

describe('prepareWorkerWorktree: Tier 0 context deploy, clean bridges, verified sections (#3685)', () => {
  // Round 2: the provider set resolves through `readAiwgConfig` (async),
  // so tests inject the loader (`contextReadConfig`) and the src-side
  // union (`contextResolveFromConfig`) instead of dropping raw JSON files.
  const contextSeams = {
    contextReadConfig: async () => ({ providers: ['muse', 'codex'] }),
    contextResolveFromConfig: resolveWorkerContextProvidersFromConfig,
  };
  function aiwgRepo() {
    const repoRoot = tmpRepo();
    writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS.md\n');
    writeFileSync(path.join(repoRoot, '.gitignore'), '.muse/\n.codex/\n.claude/\n.agents/\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-q', '-m', 'tracked bridges']);
    return repoRoot;
  }

  const calls: Array<{ worktreePath: string; providers: string[] }> = [];
  afterEach(() => { calls.splice(0); });

  // Synthetic single-pass deploy: writes one rule section per provider in
  // ONE call, drops ignored provider dirs, and edits the tracked AGENTS.md
  // bridge the way a real `aiwg use all` pass does.
  function fakeDeploy({ worktreePath, providers }: any) {
    calls.push({ worktreePath, providers: [...providers] });
    for (const provider of providers) {
      const dir = path.join(worktreePath, provider === 'muse' ? '.muse' : `.${provider}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'context.md'), `synthetic ${provider} context\n`);
    }
    const agents = path.join(worktreePath, 'AGENTS.md');
    writeFileSync(agents, readFileSync(agents, 'utf8')
      + providers.map((p: string) => `<!-- AIWG:${p}-rules:start -->\n<!-- AIWG:${p}-rules:end -->\n`).join(''));
    return { providers: [...providers] };
  }

  it('deploys once for every configured provider, keeps tracked bridges clean, and reports the context', async () => {
    const repoRoot = aiwgRepo();
    const worktreesRoot = tmpWorktreesRoot();
    const registry = new WorktreeClaimRegistry();

    const outcome = await prepareWorkerWorktree({
      repoRoot, ownerId: 'writer-1', name: 'alpha',
      claims: {}, registry, worktreesRoot, deployContextFn: fakeDeploy, ...contextSeams,
    });

    expect(outcome.created).toBe(true);
    // Exactly one deploy pass covering every configured provider.
    expect(calls).toEqual([{ worktreePath: outcome.path, providers: ['muse', 'codex'] }]);
    expect(outcome.context).toEqual({ deployed: true, providers: ['muse', 'codex'], skippedBridges: ['AGENTS.md'] });
    // Context is really on disk for the worker (ignored dirs + rule sections).
    expect(readFileSync(path.join(outcome.path!, '.muse', 'context.md'), 'utf8')).toContain('synthetic muse context');
    expect(readFileSync(path.join(outcome.path!, 'AGENTS.md'), 'utf8')).toContain('<!-- AIWG:muse-rules:start -->');
    expect(readFileSync(path.join(outcome.path!, 'AGENTS.md'), 'utf8')).toContain('<!-- AIWG:codex-rules:start -->');
    // The deploy's tracked-bridge edit is hidden from the worker diff.
    expect(git(outcome.path!, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
  });

  it('fails closed when rule sections are missing: no worktree left behind, claim released', async () => {
    const repoRoot = aiwgRepo();
    const worktreesRoot = tmpWorktreesRoot();
    const registry = new WorktreeClaimRegistry();
    const claimedFile = path.join(repoRoot, 'README.md');

    await expect(prepareWorkerWorktree({
      repoRoot, ownerId: 'writer-1', name: 'alpha',
      claims: { files: [claimedFile] }, registry, worktreesRoot,
      deployContextFn: () => ({ providers: ['muse'] }), ...contextSeams,
    })).rejects.toThrow(/rule sections/);

    expect(registry.list()).toEqual([]);
    expect(registry.claim('writer-2', { files: [claimedFile] }).granted).toBe(true);
    expect(git(repoRoot, ['worktree', 'list']).split('\n')).toHaveLength(1);
  });
});

describe('#2889 conductor adjudication: claim identity survives aliases', () => {
  it('collides hardlink aliases of the same inode', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiwg-claim-hardlink-'));
    try {
      const original = path.join(dir, 'a.ts');
      writeFileSync(original, 'x');
      const alias = path.join(dir, 'b.ts');
      linkSync(original, alias);
      const registry = new WorktreeClaimRegistry();
      expect(registry.claim('w1', { files: [original] }).granted).toBe(true);
      const attempt = registry.claim('w2', { files: [alias] });
      expect(attempt.granted).toBe(false);
      expect(attempt.conflicts).toHaveLength(1);
      expect(attempt.conflicts[0].heldBy).toBe('w1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('collides a claim made before the file existed with a claim made after it appears', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiwg-claim-appear-'));
    try {
      const file = path.join(dir, 'later.ts');
      const registry = new WorktreeClaimRegistry();
      expect(registry.claim('w1', { files: [file] }).granted).toBe(true);
      writeFileSync(file, 'now exists');
      const attempt = registry.claim('w2', { files: [file] });
      expect(attempt.granted).toBe(false);
      expect(attempt.conflicts).toHaveLength(1);
      expect(attempt.conflicts[0].heldBy).toBe('w1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
