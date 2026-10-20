import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

describe('deployment cache test-lane setup', () => {
  it('preserves both setup hooks, isolates per-file environment and cleans its owned cache', async () => {
    const config = (await import('../../../config/vitest.config.js')).default;
    expect(config.test.globalSetup).toEqual(['./test/helpers/prebuilt-relations-setup.mjs', './test/helpers/deployment-cache-setup.mjs']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-cache-config-'));
    try {
      fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
      const helpers = path.join(root, 'test/helpers');
      const events = path.join(dir, 'events');
      const marker = text => `appendFileSync(${JSON.stringify(events)}, ${JSON.stringify(text + '\n')});`;
      // The outer lane already runs the real prebuilt setup. Do not rebuild its
      // shared directory concurrently with readers in this nested runner.
      fs.writeFileSync(path.join(dir, 'prebuilt.mjs'), `import { appendFileSync } from 'node:fs'; export default () => { ${marker('prebuilt')} };`);
      fs.writeFileSync(path.join(dir, 'cache.mjs'), `import { appendFileSync } from 'node:fs'; import setup from ${JSON.stringify(pathToFileURL(path.join(helpers, 'deployment-cache-setup.mjs')).href)}; export default p => { ${marker('cache')} const end = setup(p); return () => { end(); ${marker('teardown')} }; };`);
      const names = ['test/integration/use-all-deployment.test.ts', 'test/integration/hermes-deployment.test.ts', 'test/integration/project-local-deploy.test.ts', 'test/unit/mutable-fixture.test.ts'];
      for (const name of names) {
        const target = path.join(dir, name); fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `import { it } from 'vitest'; import { writeFileSync } from 'node:fs'; it('captures environment', () => writeFileSync(${JSON.stringify(path.join(dir, name.replaceAll('/', '_') + '.json'))}, JSON.stringify({ binding: process.env.AIWG_RULE_BINDING_INDEX_CACHE ?? null, framework: process.env.AIWG_FRAMEWORK_INDEX_CACHE ?? null, source: process.env.AIWG_FRAMEWORK_INDEX_CACHE_SOURCE ?? null })));`);
      }
      fs.writeFileSync(path.join(dir, 'vitest.config.mjs'), `export default { test: { globalSetup: [${JSON.stringify(path.join(dir, 'prebuilt.mjs'))}, ${JSON.stringify(path.join(dir, 'cache.mjs'))}], setupFiles: [${JSON.stringify(path.join(helpers, 'deployment-cache-isolation.mjs'))}], maxWorkers: 1 } };`);
      const run = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(dir, 'vitest.config.mjs')], { cwd: dir, encoding: 'utf8', timeout: 180_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
      expect(run.error?.message ?? run.stderr).toBeFalsy(); expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(fs.readFileSync(events, 'utf8').trim().split('\n')).toEqual(['prebuilt', 'cache', 'teardown']);
      const results = names.map(name => JSON.parse(fs.readFileSync(path.join(dir, name.replaceAll('/', '_') + '.json'), 'utf8')));
      for (const item of results.slice(0, 2)) expect(item).toMatchObject({ binding: expect.any(String), framework: expect.any(String), source: fs.realpathSync(root) });
      expect(results[0].binding).toBe(results[1].binding);
      expect(results[2]).toMatchObject({ binding: null, framework: expect.any(String) });
      expect(results[3]).toEqual({ binding: null, framework: null, source: null });
      expect(fs.existsSync(path.dirname(path.dirname(results[0].binding)))).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 200_000);
});
