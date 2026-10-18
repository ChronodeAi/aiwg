import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** Minimal linked-worktree metadata; no repository history or session content. */
export async function createSessionWorktree(mainRepository: string, worktree: string): Promise<void> {
  const gitdir = join(mainRepository, '.git', 'worktrees', 'topic');
  await mkdir(gitdir, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(join(worktree, '.git'), `gitdir: ${relative(worktree, gitdir)}\n`);
  await writeFile(join(gitdir, 'commondir'), '../..\n');
  await writeFile(join(gitdir, 'gitdir'), `${relative(gitdir, join(worktree, '.git'))}\n`);
}
