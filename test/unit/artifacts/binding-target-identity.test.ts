/** Keep physical source aliases separate from genuinely different targets. */
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MetadataEntry } from '../../../src/artifacts/types.js';
import { createRuleBindingTargetResolver, resolveRuleBindingTarget } from '../../../src/artifacts/query-engine.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-binding-identity-'));
  roots.push(root);
  const write = (file: string): MetadataEntry => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '---\nname: a\n---\n# A\n');
    return { type: 'agent', path: file, name: 'a', tags: [], dependencies: [], dependents: [] } as MetadataEntry;
  };
  return { root, write };
}

it('collapses relative, absolute and realpath aliases without changing the selected metadata', () => {
  const { root, write } = fixture();
  const source = write(path.join(root, 'bundle/agents/a.md'));
  fs.symlinkSync(path.join(root, 'bundle'), path.join(root, 'alias'), 'dir');
  const entries = [source, { ...source, path: 'bundle/agents/a.md' }, { ...source, path: 'alias/agents/a.md' }];
  expect(resolveRuleBindingTarget(entries, 'agent', 'a', { cwd: root })).toBe(source);
});

it('collapses staged copies and prefers the current bundle entry in either input order', () => {
  const { root, write } = fixture();
  const bundle = path.join(root, 'original/bundle');
  const snapshot = path.join(root, 'external-input/bundle');
  const source = write(path.join(bundle, 'agents/a.md'));
  const staged = write(path.join(snapshot, 'agents/a.md'));
  const mirror = write(path.join(root, 'input/bundle/agents/a.md'));
  const logicalPath = (file: string) => file.replace(snapshot, bundle).replace(path.join(root, 'input/bundle'), bundle);
  for (const entries of [[source, mirror, staged], [staged, mirror, source]]) {
    expect(createRuleBindingTargetResolver(entries, { logicalPath })('agent', 'a', snapshot)).toBe(staged);
    expect(resolveRuleBindingTarget(entries, 'agent', 'a', { logicalPath })).toBe(entries[0]);
  }
});

it('prefers the owning bundle before general project or package precedence', () => {
  const { root, write } = fixture();
  const bundle = path.join(root, 'bundle');
  const own = write(path.join(bundle, 'agents/a.md'));
  const external = { ...write(path.join(root, '.aiwg/agents/a.md')), indexScope: 'project' };
  expect(resolveRuleBindingTarget([external, own], 'agent', 'a', { bundleRoot: bundle })).toBe(own);
});

it('recognizes a bundled symlink even when its physical target is outside the bundle', () => {
  const { root, write } = fixture();
  const source = write(path.join(root, 'shared/a.md'));
  const bundle = path.join(root, 'bundle');
  fs.mkdirSync(path.join(bundle, 'agents'), { recursive: true });
  const link = { ...source, path: path.join(bundle, 'agents/a.md') };
  fs.symlinkSync(source.path, link.path);
  const other = write(path.join(root, 'other/a.md'));
  expect(resolveRuleBindingTarget([other, source, link], 'agent', 'a', { bundleRoot: bundle })).toBe(link);
});

it('retains ambiguity for distinct files even when their contents match', () => {
  const { root, write } = fixture();
  const entries = [write(path.join(root, 'bundle/agents/a.md')), write(path.join(root, 'bundle/agents/b.md'))];
  expect(() => createRuleBindingTargetResolver(entries, { bundleRoot: path.join(root, 'bundle') })('agent', 'a'))
    .toThrow(`Ambiguous agent binding target: a: ${entries.map(entry => entry.path).join(', ')}`);
});

it('does not mistake a sibling with a shared path prefix for a bundle member', () => {
  const { root, write } = fixture();
  const entries = [write(path.join(root, 'bundle-two/agents/a.md')), write(path.join(root, 'other/agents/a.md'))];
  expect(() => resolveRuleBindingTarget(entries, 'agent', 'a', { bundleRoot: path.join(root, 'bundle') }))
    .toThrow('Ambiguous agent binding target: a:');
});
