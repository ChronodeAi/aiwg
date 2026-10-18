import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Match direct execution even when the installation root is a symlink. */
export function isMain(moduleUrl) {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
