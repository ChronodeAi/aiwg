import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(__dirname, '../../..');
const fake = 'fixture-issue-sensitive-value-3079';
let root: string;
let bin: string;
let children: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-issue-sensitive-debug-'));
  bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  children = path.join(root, 'children');
  const stub = `#!${process.execPath}\nconst fs = require('node:fs');\n` +
    `fs.appendFileSync(${JSON.stringify(children)}, JSON.stringify({argv:process.argv,env:process.env})+'\\n');\n` +
    `if(process.argv.includes('lookup')||process.argv.includes('find-generic-password'))process.stdout.write(${JSON.stringify(fake)});\n`;
  for (const name of ['secret-tool', 'security']) fs.writeFileSync(path.join(bin, name), stub, { mode: 0o755 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(path.join(repo, 'dist/src', file)).href);

describe.skipIf(process.platform === 'win32')('live issue sources with NODE_DEBUG=child_process', () => {
  const cases = ['import', 'export'].flatMap(operation => ['stdin', 'file', 'store', 'env', 'legacy-env'].map(source => ({ operation, source })));
  it.each(cases)('$operation/$source confines the bearer to the HTTP recipient through output and errors', ({ operation, source }) => {
    const file = path.join(root, 'private-token'); fs.writeFileSync(file, fake, { mode: 0o600 });
    const sourceArgs = source === 'legacy-env' ? [] : [`--token-${source}`, ...(source === 'file' ? [file] : source === 'store' ? ['fixture'] : source === 'env' ? ['EXAMPLE_VALUE'] : [])];
    const importArgs = operation === 'import' ? sourceArgs : ['--token-file', file];
    const exportArgs = operation === 'export' ? sourceArgs : ['--token-file', file];
    const requests = path.join(root, 'requests');
    const runner = path.join(root, 'runner.mjs');
    fs.writeFileSync(runner,
      `import fs from 'node:fs';\nimport {main} from ${moduleUrl('issues/cli.js')};\n` +
      `import {defaultCommandRunner} from ${moduleUrl('auth/credential-store.js')};\n` +
      `let fail=false;\n` +
      `globalThis.fetch=async (url,init)=>{\n` +
      `fs.appendFileSync(${JSON.stringify(requests)},JSON.stringify({url,init})+'\\n');\n` +
      `const bearer=init.headers.Authorization.slice(7);\n` +
      `if(fail)throw new Error('Transport rejected '+bearer);\n` +
      `return new Response(JSON.stringify(url.endsWith('/comments')?[]:{number:42,title:'Reflected '+bearer,body:bearer,updated_at:'2026-01-01T00:00:00Z'}));};\n` +
      `await main(['init','--prefix','DEBUG']);\n` +
      `await main(['import','--from','github','--live','--repo','acme/project','--external-id','42','--json',...${JSON.stringify(importArgs)}]);\n` +
      `fail=true;\n` +
      // Only one operation selects stdin in each run.
      `try{await main(['export','DEBUG-0001','--to','github','--live','--repo','acme/project','--force',...${JSON.stringify(exportArgs)}]);throw new Error('Expected request failure');}\n` +
      `catch(error){if(!error.message.includes('[REDACTED]'))throw error;console.error(error.message);}\n` +
      `await defaultCommandRunner('secret-tool',['clear','service','fixture','account','fixture']);\n`);
    const result = spawnSync(process.execPath, [runner], {
      input: source === 'stdin' ? fake : '', encoding: 'utf8', cwd: root,
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: root, XDG_CONFIG_HOME: root,
        NODE_DEBUG: 'child_process', EXAMPLE_VALUE: fake, DUPLICATE_VALUE: fake,
        ...(source === 'legacy-env' ? { AIWG_GITHUB_TOKEN: fake } : {}) },
      timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(fake);
    expect(result.stdout).toContain('[REDACTED]');
    expect(result.stderr).toContain('[REDACTED]');
    expect(fs.readFileSync(children, 'utf8')).not.toContain(fake);
    const captured = fs.readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(captured).toHaveLength(3);
    for (const request of captured) {
      expect(request.url).not.toContain(fake);
      expect(request.init.headers.Authorization).toBe(`Bearer ${fake}`);
      expect(request.init.body ?? '').not.toContain(fake);
    }
    expect(fs.readFileSync(path.join(root, '.aiwg/issues/items/DEBUG-0001.md'), 'utf8')).not.toContain(fake);
  });
});
