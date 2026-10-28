// Shared manifest selection for CLI staging and package dependency checks.
import { globSync } from 'glob';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const CLI_FILES_LIST = 'packages/cli/package.json "files"';

export function isCliPackageFile(filename, entries) {
  let included = false;
  for (const entry of entries) {
    const exclude = entry.startsWith('!');
    const pattern = exclude ? entry.slice(1) : entry;
    if (filename === pattern || (pattern.endsWith('/') && filename.startsWith(pattern))
      || path.matchesGlob(filename, pattern)) included = !exclude;
  }
  return included;
}

export function cliToolFiles(root, entries) {
  for (const entry of entries.filter(entry => entry.startsWith('tools/'))) {
    if (!/[*?{[]/.test(entry) && !existsSync(path.join(root, entry))) {
      throw new Error(`${entry}: source missing for ${CLI_FILES_LIST}`);
    }
  }
  return globSync('tools/**/*', { cwd: root, nodir: true })
    .filter(filename => isCliPackageFile(filename, entries)).sort();
}
