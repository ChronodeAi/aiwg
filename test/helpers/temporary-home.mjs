// Own the HOME and resolver overrides shared by isolated test lanes.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createTemporaryHome(prefix) {
  const home = mkdtempSync(path.join(os.tmpdir(), prefix));
  const env = {
    HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local/state'),
    AIWG_CONFIG: path.join(home, '.aiwg'), npm_config_cache: path.join(home, '.npm'),
  };
  return { home, env, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
