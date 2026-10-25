import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(__dirname, '../../..');
const fake = 'fixture-sensitive-value-3079';
let root: string;
let bin: string;
let capture: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-sensitive-debug-'));
  bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  capture = path.join(root, 'capture'); fs.mkdirSync(capture);
  const stub = `#!${process.execPath}\nconst fs = require('node:fs');\n` +
    `const name = require('node:path').basename(process.argv[1]);\n` +
    `fs.appendFileSync(${JSON.stringify(path.join(capture, 'children'))}, JSON.stringify({argv:process.argv,env:process.env})+'\\n');\n` +
    `let value=''; process.stdin.on('data', c=>value+=c);\n` +
    `process.stdin.on('end',()=> {\n` +
    `if((name==='secret-tool' && process.argv[2]==='lookup') || (name==='security' && process.argv[2]==='find-generic-password')) process.stdout.write(${JSON.stringify(fake)});\n` +
    `else fs.writeFileSync(${JSON.stringify(path.join(capture, 'stdin'))},value);\n` +
    `});\n`;
  for (const name of ['codex', 'secret-tool', 'security']) fs.writeFileSync(path.join(bin, name), stub, { mode: 0o755 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function run(script: string, input = '', extra: Record<string, string> = {}, commandArgs?: string[]) {
  const runner = path.join(root, 'runner.mjs');
  fs.writeFileSync(runner, script);
  const result = spawnSync(process.execPath, commandArgs ?? [runner], {
    input, encoding: 'utf8', cwd: root,
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: root, XDG_CONFIG_HOME: root,
      CODEX_HOME: path.join(root, '.codex'), NODE_DEBUG: 'child_process', EXAMPLE_VALUE: fake, DUPLICATE_VALUE: fake, ...extra },
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout + result.stderr).not.toContain(fake);
  if (fs.existsSync(path.join(capture, 'children'))) {
    expect(fs.readFileSync(path.join(capture, 'children'), 'utf8')).not.toContain(fake);
  }
  return result;
}
const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(path.join(repo, 'dist/src', file)).href);

describe.skipIf(process.platform === 'win32')('adopted commands with NODE_DEBUG=child_process', () => {
  it.each(['stdin', 'file', 'store', 'env'] as const)('MCP login %s keeps value out of child env, argv and output', source => {
    const file = path.join(root, 'input'); fs.writeFileSync(file, `${fake}\n`, { mode: 0o600 });
    const args = ['profile', 'login', 'fixture', `--api-key-${source}`, ...(source === 'file' ? [file] : source === 'store' ? ['fixture'] : source === 'env' ? ['EXAMPLE_VALUE'] : [])];
    const result = run('', source === 'stdin' ? `${fake}\n` : '', {}, [path.join(repo, 'src/mcp/cli.mjs'), ...args]);
    expect(result.stdout).toContain('Logged in to profile');
    expect(fs.readFileSync(path.join(capture, 'stdin'), 'utf8')).toBe(fake);
    expect(fs.existsSync(path.join(capture, 'children'))).toBe(true);
  });

  it.each(['stdin', 'file', 'store', 'env'] as const)('decision setup %s hides input and leaves helper children clean', source => {
    const file = path.join(root, 'input'); fs.writeFileSync(file, fake, { mode: 0o600 });
    const args = ['setup', 'jev', `--token-${source}`, ...(source === 'file' ? [file] : source === 'store' ? ['fixture'] : source === 'env' ? ['EXAMPLE_VALUE'] : [])];
    run(`import {decisionHandler} from ${moduleUrl('cli/handlers/decision.js')};\n` +
      `const r=await decisionHandler.execute({args:${JSON.stringify(args)},rawArgs:[],cwd:${JSON.stringify(root)},frameworkRoot:${JSON.stringify(repo)}});\n` +
      `console.log(r.message??'');process.exitCode=r.exitCode;\n` +
      `import {defaultCommandRunner} from ${moduleUrl('auth/credential-store.js')};\n` +
      `await defaultCommandRunner('secret-tool',['clear','service','fixture','account','fixture']);`, source === 'stdin' ? fake : '');
    expect(fs.existsSync(path.join(capture, 'children'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'aiwg/credentials/jev.json'), 'utf8')).toContain(fake);
  });

  it.each(['stdin', 'file', 'store', 'env'] as const)('auth secret set %s saves through stdin without debug exposure', source => {
    const file = path.join(root, 'input'); fs.writeFileSync(file, fake, { mode: 0o600 });
    const args = ['secret', 'set', 'fixture', `--value-${source}`, ...(source === 'file' ? [file] : source === 'store' ? ['fixture-source'] : source === 'env' ? ['EXAMPLE_VALUE'] : [])];
    run(`import {createAuthHandler} from ${moduleUrl('cli/handlers/auth.js')};\n` +
      `const r=await createAuthHandler().execute({args:${JSON.stringify(args)},rawArgs:[],cwd:${JSON.stringify(root)},frameworkRoot:${JSON.stringify(repo)}});\n` +
      `console.log(r.message??'');process.exitCode=r.exitCode;`, source === 'stdin' ? fake : '');
    expect(fs.readFileSync(path.join(capture, 'stdin'), 'utf8')).toBe(fake);
    expect(fs.existsSync(path.join(capture, 'children'))).toBe(true);
  });
});
