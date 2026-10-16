import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('frozen worker invocation loads frozen shell and stdin helpers without loading their live versions', () => {
  const baseline = new URL('../../fixtures/ralph-recovery-baseline/', import.meta.url);
  const live = new URL('../../../src/mcp/tools/', import.meta.url);
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const baseline = ${JSON.stringify(baseline.href)};
    const live = ${JSON.stringify(live.href)};
    const helpers = ['worker-shell-control.mjs', 'worker-stdin-runtime.mjs'];
    const loaded = new Set();
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        const result = nextResolve(specifier, context);
        for (const helper of helpers) {
          assert.notEqual(result.url, new URL(helper, live).href,
            'frozen reference must not depend on the live ' + helper);
          if (result.url === new URL(helper, baseline).href) loaded.add(helper);
        }
        return result;
      },
    });
    try {
      await import(new URL('worker-invoke.mjs', baseline).href);
      assert.deepEqual([...loaded].sort(), helpers);
      process.stdout.write('frozen helpers loaded');
    } finally {
      hooks.deregister();
    }
  `], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(output, 'frozen helpers loaded');
});
