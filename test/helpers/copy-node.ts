import { constants } from 'node:fs';
import { chmod, copyFile } from 'node:fs/promises';
import path from 'node:path';

// Toolcache Node may be group-writable or hardlinked. Qualification fixtures
// own their executable instead of inheriting the runner's installation modes.
export async function copyNode(directory: string, source = process.execPath): Promise<string> {
  const executable = path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
  await copyFile(source, executable, constants.COPYFILE_FICLONE);
  await chmod(executable, 0o755);
  return executable;
}
