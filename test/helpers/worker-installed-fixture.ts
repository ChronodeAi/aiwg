// Copy trusted worker code into a disposable installation for CLI and permission tests.
import { mkdir, cp, chmod, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';

export async function workerInstalledFixture(root: string, repo = process.cwd()) {
  const installed = path.join(root, 'installed');
  await mkdir(path.join(installed, 'dist'), { recursive: true, mode: 0o755 });
  await cp(path.join(repo, 'package.json'), path.join(installed, 'package.json'));
  await cp(path.join(repo, 'dist/src'), path.join(installed, 'dist/src'), { recursive: true,
    filter: filename => !filename.endsWith('.map') && !filename.endsWith('.d.ts') && !filename.endsWith('.d.mts') });
  await cp(path.join(repo, 'tools'), path.join(installed, 'tools'), { recursive: true });
  async function trust(directory: string) {
    await chmod(directory, 0o755);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await trust(filename);
      else if (entry.isFile()) await chmod(filename, 0o644);
    }
  }
  await cp(path.join(repo, 'bin'), path.join(installed, 'bin'), { recursive: true });
  await trust(installed);
  for (const directory of ['node_modules', 'agentic', 'schemas', 'vscode-extension']) await symlink(path.join(repo, directory), path.join(installed, directory));
  return installed;
}
