/** One content-keyed source cache per run; fixture and project indexes stay private. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default function setup(project) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const hash = createHash('sha256');
  const digest = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) digest(file);
      else if (entry.isFile()) {
        hash.update(path.relative(root, file)).update('\0').update(fs.readFileSync(file)).update('\0');
      }
    }
  };
  for (const directory of ['agentic/code', 'docs', 'src/artifacts', 'tools/agents']) digest(path.join(root, directory));
  hash.update(fs.readFileSync(path.join(root, 'package.json')));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-source-cache-'));
  const cache = path.join(directory, hash.digest('hex'));
  // Vitest serializes config.env into every worker, including child-process envs.
  const env = {
    AIWG_RULE_BINDING_INDEX_CACHE: path.join(cache, 'bindings'),
    AIWG_FRAMEWORK_INDEX_CACHE: path.join(cache, 'framework'),
    AIWG_FRAMEWORK_INDEX_CACHE_SOURCE: fs.realpathSync(root),
  };
  project.config.env = { ...project.config.env, ...env };
  return () => fs.rmSync(directory, { recursive: true, force: true });
}
