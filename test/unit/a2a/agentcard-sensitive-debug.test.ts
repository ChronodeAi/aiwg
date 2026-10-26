import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(__dirname, '../../..');
const secret = 'fixture-agentcard-sensitive-3079';
let root: string;
let capture: string;
let bin: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-agentcard-debug-'));
  bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  capture = path.join(root, 'children.jsonl');
  const helper = `#!${process.execPath}\nconst fs=require('node:fs');\n` +
    `fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv,env:process.env})+'\\n');\n` +
    `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(secret)}));\n`;
  for (const name of ['secret-tool', 'security']) fs.writeFileSync(path.join(bin, name), helper, { mode: 0o755 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(path.join(repo, 'dist/src', file)).href);

describe.skipIf(process.platform === 'win32')('agentcard sources with NODE_DEBUG=child_process', () => {
  it.each(['stdin', 'file', 'store', 'env'] as const)('%s keeps bearer in the HTTP recipient only', source => {
    const file = path.join(root, 'private'); fs.writeFileSync(file, secret, { mode: 0o600 });
    const recipient = path.join(root, 'http.json');
    const args = ['verify', '--host', 'https://exec.test', '--instance', 'inst-1', '--skip-verify', '--json', `--bearer-${source}`,
      ...(source === 'file' ? [file] : source === 'store' ? ['fixture'] : source === 'env' ? ['FIXTURE_BEARER'] : [])];
    const failureArgs = source === 'stdin' ? [...args.slice(0, -1), '--bearer-env', 'FIXTURE_BEARER'] : args;
    const runner = path.join(root, 'runner.mjs');
    fs.writeFileSync(runner,
      `import {agentcardHandler} from ${moduleUrl('cli/handlers/agentcard.js')};\n` +
      `import {defaultCommandRunner} from ${moduleUrl('auth/credential-store.js')};\n` +
      `import fs from 'node:fs';\n` +
      `globalThis.fetch=async (url,init)=>{fs.writeFileSync(${JSON.stringify(recipient)},JSON.stringify({url,init}));\n` +
      `return new Response(JSON.stringify({protocolVersion:'0.3.0',name:init.headers.authorization,url:'https://exec.test',version:'1'}));};\n` +
      `const args=${JSON.stringify(args)};\n` +
      `const first=await agentcardHandler.execute({args});\n` +
      `if(first.exitCode) throw new Error(first.message??'verification failed');\n` +
      `globalThis.fetch=async (_url,init)=>{throw new Error('reflected '+init.headers.authorization);};\n` +
      `const second=await agentcardHandler.execute({args:${JSON.stringify(failureArgs)}});\n` +
      `if(second.exitCode!==1) throw new Error('failure must return nonzero');\n` +
      `console.log(JSON.stringify(second));\n` +
      // Trigger the same allowlisted helper owner used by a native-store source.
      `await defaultCommandRunner('secret-tool',['lookup','service','fixture','account','fixture']);\n`);
    const result = spawnSync(process.execPath, [runner], {
      cwd: root, encoding: 'utf8', input: source === 'stdin' ? secret : '', timeout: 20_000,
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: root, XDG_CONFIG_HOME: root,
        NODE_DEBUG: 'child_process', FIXTURE_BEARER: secret, DUPLICATE_BEARER: secret },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('[REDACTED]');
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(fs.readFileSync(capture, 'utf8')).not.toContain(secret);
    const request = JSON.parse(fs.readFileSync(recipient, 'utf8'));
    expect(request.url).not.toContain(secret);
    expect(request.init.headers.authorization).toBe(`Bearer ${secret}`);
  });
});
