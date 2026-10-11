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
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  WorktreeClaimRegistry,
  prepareWorkerWorktree,
  releaseWorkerWorktree,
  resolveBaseDigest,
} from '../../../tools/ralph-external/lib/worktree-preparation.mjs';

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
  it('creates a worktree at the exact resolved base digest and records conductor ownership', () => {
    const repoRoot = tmpRepo();
    const worktreesRoot = tmpWorktreesRoot();
    const registry = new WorktreeClaimRegistry();
    const expected = git(repoRoot, ['rev-parse', 'HEAD']);

    const outcome = prepareWorkerWorktree({
      repoRoot, ownerId: 'writer-1', name: 'alpha',
      claims: { files: [path.join(repoRoot, 'README.md')] },
      registry, worktreesRoot,
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

    const outcome = prepareWorkerWorktree({ repoRoot, ownerId: 'writer-1', name: 'alpha', claims: {}, registry, worktreesRoot });

    const mode = statSync(outcome.path!).mode & 0o777;
    expect(mode).toBe(0o700);
    const rootMode = statSync(worktreesRoot).mode & 0o777;
    expect(rootMode).toBe(0o700);
  });

  it('blocks a second writer claiming the same file instead of creating a second worktree (serialize/fail, never silent overlap)', () => {
    const repoRoot = tmpRepo();
    const worktreesRoot = tmpWorktreesRoot();
    const registry = new WorktreeClaimRegistry();
    const sharedFile = path.join(repoRoot, 'README.md');

    const first = prepareWorkerWorktree({ repoRoot, ownerId: 'writer-1', name: 'alpha', claims: { files: [sharedFile] }, registry, worktreesRoot });
    expect(first.created).toBe(true);

    const second = prepareWorkerWorktree({ repoRoot, ownerId: 'writer-2', name: 'beta', claims: { files: [sharedFile] }, registry, worktreesRoot });
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

  it('releases the claim it just took when git worktree add itself fails, so a failed preparation never leaks ownership', () => {
    const repoRoot = tmpRepo();
    const worktreesRoot = tmpWorktreesRoot();
    const registry = new WorktreeClaimRegistry();
    const claimedFile = path.join(repoRoot, 'README.md');

    expect(() => prepareWorkerWorktree({
      repoRoot, ownerId: 'writer-1', name: 'alpha', revision: 'no-such-revision',
      claims: { files: [claimedFile] }, registry, worktreesRoot,
    })).toThrow();

    expect(registry.list()).toEqual([]);
    // The claim is free again for a different writer.
    expect(registry.claim('writer-2', { files: [claimedFile] }).granted).toBe(true);
  });
});

describe('releaseWorkerWorktree: dirty work is retained by default, never force-deleted (T-OG-04, T-OG-10)', () => {
  it('releases ownership bookkeeping but leaves the worktree and any dirty files on disk by default', () => {
    const repoRoot = tmpRepo();
    const worktreesRoot = tmpWorktreesRoot();
    const registry = new WorktreeClaimRegistry();
    const prepared = prepareWorkerWorktree({ repoRoot, ownerId: 'writer-1', name: 'alpha', claims: {}, registry, worktreesRoot });
    writeFileSync(path.join(prepared.path!, 'dirty-work.txt'), 'uncommitted worker output\n');

    const released = releaseWorkerWorktree({ registry, ownerId: 'writer-1', repoRoot, worktreePath: prepared.path! });

    expect(released).toEqual({ removed: false, retained: true, path: prepared.path });
    expect(existsSync(prepared.path!)).toBe(true);
    expect(readFileSync(path.join(prepared.path!, 'dirty-work.txt'), 'utf8')).toBe('uncommitted worker output\n');
    expect(registry.list()).toEqual([]);
  });

  it('removes the worktree only on an explicit remove:true opt-in', () => {
    const repoRoot = tmpRepo();
    const worktreesRoot = tmpWorktreesRoot();
    const registry = new WorktreeClaimRegistry();
    const prepared = prepareWorkerWorktree({ repoRoot, ownerId: 'writer-1', name: 'alpha', claims: {}, registry, worktreesRoot });

    const released = releaseWorkerWorktree({ registry, ownerId: 'writer-1', repoRoot, worktreePath: prepared.path!, remove: true });

    expect(released).toEqual({ removed: true, retained: false, path: prepared.path });
    expect(existsSync(prepared.path!)).toBe(false);
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
