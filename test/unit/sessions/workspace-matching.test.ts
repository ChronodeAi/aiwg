import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchSessionWorkspace } from '../../../src/sessions/workspace-matching.js';
import { createSessionWorktree } from '../../helpers/session-worktree.js';

let root: string;
let workspace: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'session-workspace-match-'));
  workspace = join(root, 'foo');
  await mkdir(workspace);
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('session workspace matching', () => {
  it('matches an exact workspace and its subfolders with path boundaries', async () => {
    const subfolder = join(workspace, 'src', 'nested');
    const sibling = join(root, 'foobar');
    await mkdir(subfolder, { recursive: true });
    await mkdir(sibling);
    expect(await matchSessionWorkspace(workspace, workspace)).toBe('exact');
    expect(await matchSessionWorkspace(subfolder, workspace)).toBe('subfolder');
    expect(await matchSessionWorkspace(sibling, workspace)).toBeNull();
    expect(await matchSessionWorkspace(root, workspace)).toBeNull();
  });

  it('resolves symlinked cwd and workspace paths before matching', async () => {
    const alias = join(root, 'alias');
    const outside = join(root, 'outside');
    await mkdir(join(workspace, 'sub'));
    await mkdir(outside);
    await symlink(workspace, alias);
    await symlink(outside, join(workspace, 'escape'));
    expect(await matchSessionWorkspace(alias, workspace)).toBe('exact');
    expect(await matchSessionWorkspace(join(alias, 'sub'), workspace)).toBe('subfolder');
    expect(await matchSessionWorkspace(join(workspace, 'sub'), alias)).toBe('subfolder');
    expect(await matchSessionWorkspace(join(workspace, 'escape'), workspace)).toBeNull();
    expect(await matchSessionWorkspace(join(alias, 'missing'), workspace)).toBe('subfolder');
    expect(await matchSessionWorkspace(join(workspace, 'missing'), alias)).toBe('subfolder');
    expect(await matchSessionWorkspace(join(workspace, 'escape', 'missing', 'nested'), workspace)).toBeNull();
  });

  it('matches a deleted nested worktree as a subfolder of its enclosing workspace', async () => {
    const worktree = join(workspace, '.claude', 'worktrees', 'topic');
    await createSessionWorktree(workspace, worktree);
    await rm(worktree, { recursive: true });
    expect(await matchSessionWorkspace(worktree, workspace)).toBe('subfolder');
    expect(await matchSessionWorkspace(join(worktree, 'src'), workspace)).toBe('subfolder');
  });

  it('matches a deleted subfolder by resolving its nearest existing ancestor', async () => {
    const subfolder = join(workspace, 'src', 'nested', 'deeper');
    await mkdir(subfolder, { recursive: true });
    await rm(join(workspace, 'src', 'nested'), { recursive: true });
    expect(await matchSessionWorkspace(subfolder, workspace)).toBe('subfolder');
  });

  it('assigns missing subfolders only to their deepest initialized catalog', async () => {
    const nested = join(workspace, 'nested');
    const deepest = join(nested, 'deeper');
    for (const path of [workspace, nested, deepest]) {
      await mkdir(join(path, '.aiwg', 'sessions'), { recursive: true });
    }
    const cwd = join(deepest, 'missing', 'sub');
    expect(await matchSessionWorkspace(cwd, workspace)).toBeNull();
    expect(await matchSessionWorkspace(cwd, nested)).toBeNull();
    expect(await matchSessionWorkspace(cwd, deepest)).toBe('subfolder');
  });

  it('rejects missing paths outside the workspace and missing workspace roots', async () => {
    expect(await matchSessionWorkspace(join(root, 'missing', 'sub'), workspace)).toBeNull();
    expect(await matchSessionWorkspace(join(root, 'foobar', 'missing'), workspace)).toBeNull();
    const missingWorkspace = join(root, 'missing-workspace');
    expect(await matchSessionWorkspace(join(missingWorkspace, 'sub'), missingWorkspace)).toBeNull();
  });

  it('rejects missing subfolders of external worktrees without direct enclosure', async () => {
    const worktree = join(root, 'worktrees', 'topic');
    await createSessionWorktree(workspace, worktree);
    expect(await matchSessionWorkspace(join(worktree, 'missing'), workspace)).toBeNull();
    expect(await matchSessionWorkspace(join(worktree, 'missing'), worktree)).toBe('subfolder');
  });

  it('rejects dangling symlinks instead of treating them as missing directories', async () => {
    const target = join(root, 'outside');
    const link = join(workspace, 'escape');
    await mkdir(target);
    await symlink(target, link);
    await rm(target, { recursive: true });
    expect(await matchSessionWorkspace(link, workspace)).toBeNull();
    expect(await matchSessionWorkspace(join(link, 'missing', 'nested'), workspace)).toBeNull();
  });

  it('rejects descendants of regular files and symlink loops', async () => {
    const file = join(workspace, 'file');
    const loop = join(workspace, 'loop');
    await writeFile(file, '');
    await symlink(loop, loop);
    expect(await matchSessionWorkspace(join(file, 'missing'), workspace)).toBeNull();
    expect(await matchSessionWorkspace(join(loop, 'missing'), workspace)).toBeNull();
  });

  it('assigns a subtree only to its deepest initialized catalog', async () => {
    const nested = join(workspace, 'nested');
    const deepest = join(nested, 'deeper');
    const cwd = join(deepest, 'sub');
    for (const path of [workspace, nested, deepest]) {
      await mkdir(join(path, '.aiwg', 'sessions'), { recursive: true });
    }
    await mkdir(cwd);
    expect(await matchSessionWorkspace(cwd, workspace)).toBeNull();
    expect(await matchSessionWorkspace(cwd, nested)).toBeNull();
    expect(await matchSessionWorkspace(cwd, deepest)).toBe('subfolder');
    expect(await matchSessionWorkspace(deepest, workspace)).toBeNull();
    expect(await matchSessionWorkspace(deepest, deepest)).toBe('exact');
  });

  it('attributes external worktree subfolders through relative Git metadata', async () => {
    const worktree = join(root, 'worktrees', 'topic');
    await createSessionWorktree(workspace, worktree);
    await mkdir(join(worktree, 'sub'));
    expect(await matchSessionWorkspace(worktree, workspace)).toBe('worktree');
    expect(await matchSessionWorkspace(join(worktree, 'sub'), workspace)).toBe('worktree');
    const alias = join(root, 'worktree-alias');
    await symlink(worktree, alias);
    expect(await matchSessionWorkspace(alias, workspace)).toBe('worktree');
  });

  it('gives physical worktree catalogs precedence over main repository catalogs', async () => {
    const worktree = join(root, 'worktrees', 'topic');
    await createSessionWorktree(workspace, worktree);
    await mkdir(join(worktree, '.aiwg', 'sessions'), { recursive: true });
    expect(await matchSessionWorkspace(worktree, workspace)).toBeNull();
    expect(await matchSessionWorkspace(worktree, worktree)).toBe('exact');
    await mkdir(join(root, '.aiwg', 'sessions'), { recursive: true });
    expect(await matchSessionWorkspace(worktree, root)).toBeNull();
  });

  it('assigns worktrees only to the deepest catalog enclosing the main repository', async () => {
    const repository = join(workspace, 'nested');
    const worktree = join(root, 'worktree');
    await createSessionWorktree(repository, worktree);
    expect(await matchSessionWorkspace(worktree, workspace)).toBe('worktree');
    await mkdir(join(repository, '.aiwg', 'sessions'), { recursive: true });
    expect(await matchSessionWorkspace(worktree, workspace)).toBeNull();
    expect(await matchSessionWorkspace(worktree, repository)).toBe('worktree');
  });

  it('prefers a deeper repository catalog over a common ancestor catalog', async () => {
    const worktree = join(root, 'worktree');
    await createSessionWorktree(workspace, worktree);
    await mkdir(join(root, '.aiwg', 'sessions'), { recursive: true });
    await mkdir(join(workspace, '.aiwg', 'sessions'), { recursive: true });
    expect(await matchSessionWorkspace(worktree, root)).toBeNull();
    expect(await matchSessionWorkspace(worktree, workspace)).toBe('worktree');
  });

  it('rejects unrelated repositories, submodules, and invalid worktree backlinks', async () => {
    const worktree = join(root, 'worktree');
    await createSessionWorktree(workspace, worktree);
    const other = join(root, 'other');
    await mkdir(join(other, '.git'), { recursive: true });
    expect(await matchSessionWorkspace(other, workspace)).toBeNull();
    const unrelated = join(root, 'unrelated-worktree');
    await createSessionWorktree(other, unrelated);
    expect(await matchSessionWorkspace(unrelated, workspace)).toBeNull();
    const nested = join(worktree, 'nested');
    await mkdir(join(nested, '.git'), { recursive: true });
    expect(await matchSessionWorkspace(nested, workspace)).toBeNull();
    await rm(join(nested, '.git'), { recursive: true });
    await writeFile(join(nested, '.git'), 'gitdir: ../../foo/.git/modules/sub\n');
    expect(await matchSessionWorkspace(nested, workspace)).toBeNull();
    await writeFile(join(workspace, '.git', 'worktrees', 'topic', 'gitdir'), join(other, '.git'));
    expect(await matchSessionWorkspace(worktree, workspace)).toBeNull();
  });

  it('keeps direct matches when Git metadata is unavailable or belongs to a submodule', async () => {
    await writeFile(join(workspace, '.git'), 'gitdir: missing\n');
    expect(await matchSessionWorkspace(workspace, workspace)).toBe('exact');
    const submodule = join(workspace, 'submodule');
    const gitdir = join(root, 'git-modules', 'submodule');
    await mkdir(submodule);
    await mkdir(gitdir, { recursive: true });
    await writeFile(join(submodule, '.git'), `gitdir: ${gitdir}\n`);
    expect(await matchSessionWorkspace(submodule, workspace)).toBe('subfolder');
  });
});
