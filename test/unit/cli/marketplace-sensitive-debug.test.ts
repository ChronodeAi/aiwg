import { spawnSync, execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repository = path.resolve(__dirname, '../../..');
let root: string;
let checkout: string;
let bin: string;
let capture: string;
let pem: string;
let actualGit: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-marketplace-sensitive-'));
  bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  checkout = path.join(root, 'package'); fs.mkdirSync(checkout);
  capture = path.join(root, 'children.jsonl');
  actualGit = execFileSync('which', ['git'], { encoding: 'utf8', timeout: 10_000 }).trim();
  const git = (args: string[]) => execFileSync(actualGit, args, { cwd: checkout, encoding: 'utf8', timeout: 10_000 });
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['remote', 'add', 'origin', 'https://example.invalid/acme/package.git']);
  fs.writeFileSync(path.join(checkout, 'manifest.json'), JSON.stringify({
    id: 'fixture', type: 'extension', name: 'Fixture', version: '1.0.0', description: 'Fixture',
    manifestVersion: '1', platforms: { claude: 'full' }, keywords: ['fixture'],
    deployment: { pathTemplate: '{provider}/extensions/fixture' }, extensionConfig: {}, author: 'acme', license: 'MIT',
  }));
  git(['add', '.']); git(['commit', '--quiet', '-m', 'fixture']);
  pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function run(source: string, material: string) {
  const inputPath = path.join(root, 'private.pem');
  fs.writeFileSync(inputPath, material, { mode: 0o600 });
  const prelude = `#!${process.execPath}\nconst fs=require('node:fs');\n` +
    `fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv,env:process.env})+'\\n');\n`;
  fs.writeFileSync(path.join(bin, 'git'), prelude +
    `const cp=require('node:child_process');process.stdout.write(cp.execFileSync(${JSON.stringify(actualGit)},process.argv.slice(2),{cwd:process.cwd(),env:process.env,timeout:10000}));`, { mode: 0o755 });
  for (const helper of ['secret-tool', 'security']) fs.writeFileSync(path.join(bin, helper), prelude +
    `process.stdout.write(${JSON.stringify(material)});`, { mode: 0o755 });
  const args = ['publish', checkout, '--publisher', 'acme', '--output', path.join(root, 'output'),
    source === 'legacy' ? '--key' : `--key-${source}`,
    ...(source === 'file' || source === 'legacy' ? [inputPath] : source === 'store' ? ['fixture'] : source === 'env' ? ['FIXTURE_PEM'] : [])];
  const runner = path.join(root, 'runner.mjs');
  fs.writeFileSync(runner, `import {marketplaceHandler} from ${JSON.stringify(pathToFileURL(path.join(repository, 'dist/src/cli/handlers/marketplace.js')).href)};
const result=await marketplaceHandler.execute({args:${JSON.stringify(args)},rawArgs:[],cwd:${JSON.stringify(root)},frameworkRoot:${JSON.stringify(repository)}});
console.log(result.message??'');process.exitCode=result.exitCode;
`);
  const result = spawnSync(process.execPath, [runner], {
    cwd: root, encoding: 'utf8', input: source === 'stdin' ? material : '', timeout: 30_000,
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: root, XDG_CONFIG_HOME: root,
      NODE_DEBUG: 'child_process', FIXTURE_PEM: material, DUPLICATE_PEM: material },
  });
  expect(result.error).toBeUndefined();
  const privateLine = material.split('\n')[1];
  expect(result.stdout + result.stderr).not.toContain(privateLine);
  expect(fs.existsSync(capture)).toBe(true);
  const childState = fs.readFileSync(capture, 'utf8');
  expect(childState).not.toContain(privateLine);
  expect(childState).not.toContain('FIXTURE_PEM');
  expect(childState).not.toContain('DUPLICATE_PEM');
  return result;
}

describe.skipIf(process.platform === 'win32')('marketplace private PEM under child-process debug logging', () => {
  it.each(['stdin', 'file', 'legacy', 'store', 'env'])('%s keeps private material out of Git argv, helper environments and output', source => {
    const result = run(source, pem);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('Published signed envelope');
  });

  it.each(['stdin', 'file', 'legacy', 'store', 'env'])('%s hides malformed multiline material in signing errors', source => {
    const result = run(source, 'invalid-private-header\nfixture-private-body-3079\ninvalid-footer');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Marketplace signing failed');
  });
});
