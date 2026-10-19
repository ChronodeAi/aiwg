import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectGraphIndexFiles } from '../../../src/artifacts/index-files.js';
import { GRAPH_CONFIGS } from '../../../src/artifacts/types.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it('excludes symlinked sources and rechecks ancestor safety on each scan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-index-files-'));
  roots.push(root);
  const source = path.join(root, 'src');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(source);
  fs.mkdirSync(outside);
  for (const name of ['a.ts', 'b.ts']) fs.writeFileSync(path.join(source, name), 'export {};');
  fs.writeFileSync(path.join(outside, 'escaped.ts'), 'export {};');
  fs.symlinkSync(outside, path.join(source, 'alias'), 'dir');
  fs.symlinkSync(path.join(source, 'a.ts'), path.join(source, 'alias.ts'), 'file');
  const fileStats = new Map<string, fs.Stats>();
  expect((await collectGraphIndexFiles(root, 'codebase', { fileStats })).sort())
    .toEqual(['a.ts', 'b.ts'].map(name => path.join(source, name)));
  expect([...fileStats.keys()].sort()).toEqual(['a.ts', 'b.ts'].map(name => path.join(source, name)));
  fs.renameSync(source, path.join(root, 'previous-src'));
  fs.symlinkSync(outside, source, 'dir');
  expect(await collectGraphIndexFiles(root, 'codebase', { fileStats })).toEqual([]);
  expect(fileStats.size).toBe(0);
});

it('keeps runtime exclusions for both regular leaves and directories with an authorized parent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-index-leaves-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.aiwg', 'scratch'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aiwg', 'working'), 'runtime leaf');
  fs.writeFileSync(path.join(root, '.aiwg', 'scratch', 'hidden.md'), 'runtime directory');
  fs.writeFileSync(path.join(root, '.aiwg', 'keep.md'), 'canonical');
  GRAPH_CONFIGS['leaf-probe'] = { ...GRAPH_CONFIGS.codebase, type: 'leaf-probe',
    scanDirs: ['.aiwg'], extensions: [''] };
  try {
    const fileStats = new Map<string, fs.Stats>();
    const expected = [path.join(root, '.aiwg', 'keep.md')];
    expect(await collectGraphIndexFiles(root, 'leaf-probe', { fileStats })).toEqual(expected);
    expect([...fileStats.keys()]).toEqual(expected);
  } finally { delete GRAPH_CONFIGS['leaf-probe']; }
});

it('preserves ignored-root exemptions, negations and external roots when batching sibling probes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-index-ignore-'));
  roots.push(root);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  execFileSync('git', ['init', '--quiet'], { cwd: project });
  const relative = ['src/keep.ts', 'src/drop.ts', 'test/cold.ts', 'tools/keep.ts', 'tools/drop.ts'];
  for (const file of [...relative.map(file => path.join(project, file)), path.join(root, 'external/outside.ts')]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export {};');
  }
  fs.writeFileSync(path.join(project, '.gitignore'), 'test/\nsrc/drop.ts\ntools/*\n!tools/keep.ts\n');
  GRAPH_CONFIGS['ignore-probe'] = { ...GRAPH_CONFIGS.codebase, type: 'ignore-probe',
    scanDirs: ['src', 'test', 'tools', path.join(root, 'external')] };
  try {
    expect((await collectGraphIndexFiles(project, 'ignore-probe')).sort()).toEqual([
      ...['src/keep.ts', 'test/cold.ts', 'tools/keep.ts'].map(file => path.join(project, file)),
      path.join(root, 'external/outside.ts'),
    ].sort());
  } finally {
    delete GRAPH_CONFIGS['ignore-probe'];
  }
});
