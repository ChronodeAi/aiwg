import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const WORKSPACE_MATCH_KINDS = ['exact', 'subfolder', 'worktree'] as const;
export type WorkspaceMatchKind = typeof WORKSPACE_MATCH_KINDS[number];

/** A nested catalog owns its subtree, even when discovery runs one workspace at a time. */
export async function matchSessionWorkspace(
  cwd: string,
  workspace: string,
): Promise<WorkspaceMatchKind | null> {
  try {
    const { path: candidate, missing } = await resolveCandidate(resolve(cwd));
    const workspacePath = await realpath(resolve(workspace));
    const direct = encloses(workspacePath, candidate);
    if (missing && !direct) return null;
    const physicalCatalog = await nearestCatalogBetween(candidate, direct ? workspacePath : undefined);
    if (physicalCatalog && !encloses(physicalCatalog, workspacePath)) return null;
    const mainRepository = await worktreeMainRepository(candidate).catch(() => null);
    // A worktree also belongs to a deeper catalog around its main repository,
    // including when both paths sit beneath the workspace being discovered.
    if (mainRepository && encloses(workspacePath, mainRepository)
      && await nearestCatalogBetween(mainRepository, workspacePath)) return null;
    if (direct) return candidate === workspacePath ? 'exact' : 'subfolder';
    if (!mainRepository || !encloses(workspacePath, mainRepository)) return null;
    return 'worktree';
  } catch {
    // Unresolved paths or Git metadata cannot establish workspace ownership.
    return null;
  }
}

async function resolveCandidate(path: string): Promise<{ path: string; missing: boolean }> {
  let ancestor = path;
  const suffix: string[] = [];
  for (;;) {
    try {
      // Stop at symlinks too, so realpath rejects dangling links below.
      await lstat(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  return { path: join(await realpath(ancestor), ...suffix), missing: suffix.length > 0 };
}

function encloses(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

async function nearestCatalogBetween(candidate: string, stop?: string): Promise<string | null> {
  for (let directory = candidate; directory !== stop; directory = dirname(directory)) {
    const catalog = await statIfPresent(join(directory, '.aiwg', 'sessions'));
    if (catalog?.isDirectory()) return directory;
    if (directory === dirname(directory)) break;
  }
  return null;
}

async function worktreeMainRepository(candidate: string): Promise<string | null> {
  for (let directory = candidate; ; directory = dirname(directory)) {
    const marker = join(directory, '.git');
    const details = await statIfPresent(marker);
    if (details) {
      // Stop at the nearest repository; a normal repository or submodule
      // must not inherit an outer worktree's ownership.
      if (!details.isFile()) return null;
      const gitfile = /^gitdir: (.+)\s*$/.exec((await readFile(marker, 'utf8')).trim());
      if (!gitfile) return null;
      const gitdir = await realpath(resolve(directory, gitfile[1].trim()));
      const common = (await readFile(join(gitdir, 'commondir'), 'utf8')).trim();
      if (!common) return null;
      const commonDir = await realpath(resolve(gitdir, common));
      const backlink = (await readFile(join(gitdir, 'gitdir'), 'utf8')).trim();
      if (!backlink || await realpath(resolve(gitdir, backlink)) !== await realpath(marker)) return null;
      // Standard linked worktrees share the main repository's .git directory.
      if (basename(commonDir) !== '.git' || commonDir === gitdir) return null;
      const mainRepository = dirname(commonDir);
      return await realpath(join(mainRepository, '.git')) === commonDir ? mainRepository : null;
    }
    if (directory === dirname(directory)) return null;
  }
}

async function statIfPresent(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}
