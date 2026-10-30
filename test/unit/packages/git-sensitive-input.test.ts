import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(__dirname, '../../..');
const secret = 'fixture-git-sensitive-3079';
const commit = 'a'.repeat(40);
let root: string;
let bin: string;
let capture: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-git-sensitive-'));
  bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  capture = path.join(root, 'children');
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const config = process.env.GIT_CONFIG_VALUE_0;
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({argv:process.argv, env:process.env})+'\\n');
if(config) {
  const content = fs.readFileSync(config, 'utf8');
  if(!content.includes('Authorization: Basic ' + Buffer.from('x-access-token:${secret}').toString('base64'))) process.exit(9);
  fs.appendFileSync(${JSON.stringify(path.join(root, 'configs'))}, JSON.stringify({config, mode:fs.statSync(config).mode & 511, dirMode:fs.statSync(path.dirname(config)).mode & 511, content})+'\\n');
}
if(args[0]==='clone') {
  if(fs.existsSync(${JSON.stringify(path.join(root, 'fail'))})) { process.stderr.write('remote echoed ${secret}'); process.exit(1); }
  fs.mkdirSync(path.join(args.at(-1), '.git'), {recursive:true});
} else if(args[0]==='ls-remote') process.stdout.write('${commit}\\trefs/heads/main\\n');
else if(args[0]==='rev-parse') process.stdout.write('${commit}\\n');
`, { mode: 0o755 });
  const store = `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(capture)}, JSON.stringify({argv:process.argv,env:process.env})+'\\n');\nprocess.stdout.write(${JSON.stringify(secret)});\n`;
  for (const name of ['secret-tool', 'security']) fs.writeFileSync(path.join(bin, name), store, { mode: 0o755 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(path.join(repo, 'dist/src', file)).href);

function run(adapter: string, source: string, fail = false, legacyFile = false) {
  const file = path.join(root, 'input'); fs.writeFileSync(file, secret, { mode: 0o600 });
  if (legacyFile) {
    const legacy = adapter === 'github' ? path.join(root, '.aiwg/credentials/github') : path.join(root, '.config/gitea/token');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, secret, { mode: 0o600 });
  }
  if (fail) fs.writeFileSync(path.join(root, 'fail'), '');
  const tokenInput = source === 'legacy' ? {} : source === 'stdin' ? { stdin: true }
    : source === 'file' ? { file } : source === 'store' ? { store: 'synthetic' }
      : source === 'interactive' ? { interactive: true } : { env: 'EXAMPLE_TOKEN' };
  const className = adapter === 'github' ? 'GitHubAdapter' : adapter === 'gitea' ? 'GiteaAdapter' : 'GitAdapter';
  const ref = { raw: 'fixture', owner: 'synthetic', name: 'package', scheme: adapter, version: 'main', rawUrl: 'https://example.invalid/synthetic/package.git' };
  const runner = path.join(root, 'runner.mjs');
  fs.writeFileSync(runner, `import {${className}} from ${moduleUrl(`packages/adapters/${adapter}.js`)};
const adapter = new ${className}();
try {
 const options={tokenInput:${JSON.stringify(tokenInput)}};
 const source = await adapter.resolve(${JSON.stringify(ref)},options);
 console.log(JSON.stringify(source));
 console.log(await adapter.fetch(source,options));
} catch(error) { console.error(error.stack); console.error(JSON.stringify(error)); ${fail || source === 'interactive' ? '' : 'process.exitCode=1;'} }
`);
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: root, XDG_CACHE_HOME: path.join(root, 'cache'),
    TMPDIR: root, NODE_DEBUG: 'child_process', EXAMPLE_TOKEN: secret, DUPLICATE_TOKEN: secret, SSH_AUTH_SOCK: '/synthetic/agent',
    ...(source === 'legacy' && !legacyFile ? { GITHUB_TOKEN: secret, GITEA_TOKEN: secret } : {}),
  };
  const result = spawnSync(process.execPath, [runner], { cwd: root, input: source === 'stdin' ? secret : '', encoding: 'utf8', env, timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout + result.stderr).not.toContain(secret);
  if (fs.existsSync(capture)) expect(fs.readFileSync(capture, 'utf8')).not.toContain(secret);
  return result;
}

describe.skipIf(process.platform === 'win32')('Git credentials under child process debug logging', () => {
  for (const adapter of ['github', 'gitea', 'git']) {
    it.each(['stdin', 'file', 'store', 'env'])(`${adapter} %s keeps tokens off argv, env, URLs and diagnostics`, source => {
      const result = run(adapter, source);
      expect(result.stdout).toContain('https://');
      const calls = fs.readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(calls.some(call => call.argv.includes('clone'))).toBe(true);
      expect(calls.filter(call => path.basename(call.argv[1]) === 'git').every(call => call.env.SSH_AUTH_SOCK === '/synthetic/agent')).toBe(true);
      expect(calls.every(call => call.env.NODE_DEBUG === undefined)).toBe(true);
      const configs = fs.readFileSync(path.join(root, 'configs'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(configs.length).toBeGreaterThan(0);
      for (const item of configs) {
        expect(item.mode).toBe(0o600); expect(item.dirMode).toBe(0o700);
        expect(item.content).toContain('[http "https://');
        expect(fs.existsSync(item.config)).toBe(false);
      }
    });
    it(`${adapter} redacts git failure objects and cleans credentials`, () => {
      const result = run(adapter, 'env', true);
      expect(result.stderr).toContain('[REDACTED]');
      for (const line of fs.readFileSync(path.join(root, 'configs'), 'utf8').trim().split('\n')) {
        expect(fs.existsSync(JSON.parse(line).config)).toBe(false);
      }
    });
  }
  it.each(['github', 'gitea'])('%s preserves legacy environment then private-file lookup', adapter => {
    run(adapter, 'legacy');
    expect(fs.existsSync(path.join(root, 'configs'))).toBe(true);
  });
  it.each(['github', 'gitea'])('%s resolves an isolated legacy private file', adapter => {
    run(adapter, 'legacy', false, true);
    expect(fs.existsSync(path.join(root, 'configs'))).toBe(true);
  });
  it('uses a config that real Git scopes to the recipient HTTPS origin', () => {
    run('git', 'env');
    const recorded = JSON.parse(fs.readFileSync(path.join(root, 'configs'), 'utf8').trim().split('\n')[0]);
    const config = path.join(root, 'scope-config');
    fs.writeFileSync(config, recorded.content, { mode: 0o600 });
    const query = (url: string) => spawnSync('git', ['config', '--file', config, '--get-urlmatch', 'http.extraHeader', url], {
      encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH },
    });
    const intended = query('https://example.invalid/synthetic/package.git');
    expect(intended.status, intended.stderr).toBe(0);
    expect(intended.stdout.trim()).toBe(`Authorization: Basic ${Buffer.from(`x-access-token:${secret}`).toString('base64')}`);
    expect(query('https://unrelated.invalid/synthetic/package.git').stdout).toBe('');
  });
  it('refuses explicit interactive input headlessly and names sources', () => {
    const result = run('github', 'interactive');
    expect(result.stderr).toContain('--token-stdin');
    expect(result.stderr).toContain('--token-store');
    expect(fs.existsSync(capture)).toBe(false);
  });
  it('keeps SSH fallback when no token was selected or configured', () => {
    run('github', 'legacy', false, true);
    // Legacy synthetic file has been checked above; remove it before resolving SSH.
    fs.rmSync(path.join(root, '.aiwg'), { recursive: true });
    const runner = path.join(root, 'ssh.mjs');
    fs.writeFileSync(runner, `import {GitHubAdapter} from ${moduleUrl('packages/adapters/github.js')}; console.log(JSON.stringify(await new GitHubAdapter().resolve({owner:'synthetic',name:'package'})));`);
    const result = spawnSync(process.execPath, [runner], { env: { HOME: root }, encoding: 'utf8', timeout: 20_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('git@github.com:synthetic/package.git');
  });
});
