// Run the real lane wrapper against a local runner that exercises its setup contract.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'lane-oracle-'));
  roots.push(root);
  for (const file of ['tools/testing/run-default-lane.mjs', 'tools/testing/check-tmpdir-leaks.mjs',
    'tools/_resolve-impl.mjs', 'src/process/signal-child.mjs',
    'test/helpers/default-home-setup.mjs', 'test/helpers/temporary-home.mjs']) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    copyFileSync(path.join(repo, file), path.join(root, file));
  }
  for (const dir of ['config', 'node_modules/vitest', 'caller-home', 'caller-tmp']) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  writeFileSync(path.join(root, 'caller-home/sentinel'), 'caller-owned');
  writeFileSync(path.join(root, 'package.json'), '{"name":"aiwg","type":"module"}');
  for (const lane of ['', '.wasm', '.deployment']) {
    writeFileSync(path.join(root, `config/vitest${lane}.config.js`), `export default {
      test: { globalSetup: ['./test/helpers/default-home-setup.mjs'] }
    };`);
  }
  // This is a fake local runner, not a nested Vitest process. It reads the actual
  // wrapper argv and executes the selected config's real default-home-setup.
  writeFileSync(path.join(root, 'node_modules/vitest/vitest.mjs'), `
    import { execFileSync } from 'node:child_process';
    import { existsSync, writeFileSync } from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const keys = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'XDG_CONFIG_HOME',
      'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'];
    const pickEnv = env => Object.fromEntries(keys.map(key => [key, env[key]]));
    const args = process.argv.slice(2);
    const config = args[args.indexOf('--config') + 1];
    const { default: value } = await import(pathToFileURL(path.resolve(config)));
    let home;
    const project = { config: { env: {} }, provide: (key, value) => { home = value; } };
    const { default: setup } = await import(pathToFileURL(path.resolve(value.test.globalSetup[0])));
    const teardown = setup(project);
    try {
      const child = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
        "import os from 'node:os'; const keys = " + JSON.stringify(keys) + "; console.log(JSON.stringify({ home: os.homedir(), env: Object.fromEntries(keys.map(key => [key, process.env[key]])) }));"
      ], { encoding: 'utf8', timeout: 10000 }));
      writeFileSync(process.env.ORACLE_RECEIPT, JSON.stringify({
        args, config, home, nativeHome: os.homedir(), env: pickEnv(process.env),
        workerEnv: project.config.env, child, privateTmp: os.tmpdir(),
      }));
    } finally { teardown(); }
    if (existsSync(home)) throw new Error('setup did not remove owned HOME');
  `);
  return root;
}

function run(root, args) {
  const caller = path.join(root, 'caller-home');
  return spawnSync(process.execPath, [path.join(root, 'tools/testing/run-default-lane.mjs'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
    env: { ...process.env, HOME: caller, USERPROFILE: caller, CODEX_HOME: path.join(caller, 'codex'),
      XDG_CONFIG_HOME: path.join(caller, 'config'), XDG_DATA_HOME: path.join(caller, 'data'),
      XDG_CACHE_HOME: path.join(caller, 'cache'), XDG_STATE_HOME: path.join(caller, 'state'),
      TMPDIR: path.join(root, 'caller-tmp'), ORACLE_RECEIPT: path.join(root, 'receipt.json') },
  });
}

describe('default lane executable contract', () => {
  it.each(['default', 'wasm', 'deployment'])('routes %s and isolates inherited HOME and every XDG directory', lane => {
    const root = fixture();
    const config = `config/vitest${lane === 'default' ? '' : '.' + lane}.config.js`;
    const args = lane === 'default' ? ['test/unit/example.test.ts'] : ['--config', config, 'test/unit/example.test.ts'];
    const result = run(root, args);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(path.join(root, 'receipt.json'), 'utf8'));
    expect(receipt.args).toEqual(['run', '--config', config, 'test/unit/example.test.ts']);
    expect(receipt.config).toBe(config);
    expect(path.dirname(receipt.home)).toBe(receipt.privateTmp);
    expect(path.basename(receipt.home)).toMatch(/^aiwg-default-home-/);
    expect(receipt.nativeHome).toBe(receipt.home);
    expect(receipt.child.home).toBe(receipt.home);
    const expected = { HOME: receipt.home, USERPROFILE: receipt.home,
      XDG_CONFIG_HOME: path.join(receipt.home, '.config'), XDG_DATA_HOME: path.join(receipt.home, '.local/share'),
      XDG_CACHE_HOME: path.join(receipt.home, '.cache'), XDG_STATE_HOME: path.join(receipt.home, '.local/state') };
    for (const env of [receipt.env, receipt.workerEnv, receipt.child.env]) {
      expect(env).toMatchObject(expected);
      expect(env.CODEX_HOME).toBeUndefined();
    }
    expect(existsSync(receipt.home)).toBe(false);
    expect(readdirSync(path.join(root, 'caller-tmp'))).toEqual([]);
    expect(readFileSync(path.join(root, 'caller-home/sentinel'), 'utf8')).toBe('caller-owned');
    expect(result.stdout).toContain('TMPDIR leak gate: 0 entries left behind.');
  });
});
