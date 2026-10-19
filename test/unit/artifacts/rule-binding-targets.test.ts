import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuleBindingTargetResolver, loadLocalCapabilityEntries, loadLocalOverrideCapabilityEntries, resolveRuleBindingTarget } from '../../../src/artifacts/query-engine.js';
import { stableRecordId } from '../../../src/artifacts/browser-export.js';
import type { MetadataEntry } from '../../../src/artifacts/types.js';
import { getGraphIndexDir, getProjectIndexRoot } from '../../../src/artifacts/types.js';

function entry(type: 'skill' | 'agent' | 'flow', path: string, name: string, indexScope?: string): MetadataEntry {
  return { type, path, name, indexScope, tags: [], dependencies: [], dependents: [] } as MetadataEntry;
}

it('preserves canonical IDs, slugs, project precedence and plugin-copy precedence', () => {
  const skill = entry('skill', 'agentic/code/frameworks/a/skills/slug/SKILL.md', 'Display name');
  const flow = entry('flow', 'agentic/code/frameworks/a/flows/ship.yaml', 'Ship');
  const canonical = entry('agent', 'agentic/code/frameworks/a/agents/owner.md', 'owner');
  const local = entry('agent', '.aiwg/extensions/local/agents/shadowed.md', 'shadowed', 'project');
  const entries = [skill, flow,
    entry('agent', 'agentic/code/plugins/a/agents/owner.md', 'owner'), canonical,
    entry('agent', 'agentic/code/frameworks/a/agents/shadowed.md', 'shadowed', 'packaged'), local];
  const resolve = createRuleBindingTargetResolver(entries);
  for (const id of ['Display name', 'slug', stableRecordId('aiwg.skill', skill.path)]) {
    expect(resolve('skill', id)).toBe(skill);
    expect(resolve('skill', id)).toBe(resolveRuleBindingTarget(entries, 'skill', id));
  }
  expect(resolve('flow', 'ship')).toBe(flow);
  expect(resolve('agent', 'owner')).toBe(canonical);
  expect(resolve('agent', 'shadowed')).toBe(local);
  expect(() => resolve('agent', 'slug')).toThrow('Missing agent binding target: slug');
});

it('keeps ambiguous targets ambiguous and rebuilds candidate indexes for a new snapshot', () => {
  const entries = [entry('agent', 'agentic/code/frameworks/a/agents/shared.md', 'shared'),
    entry('agent', 'agentic/code/frameworks/b/agents/shared.md', 'shared')];
  const resolve = createRuleBindingTargetResolver(entries);
  expect(() => resolve('agent', 'shared')).toThrow('Ambiguous agent binding target: shared');
  const late = entry('agent', 'agentic/code/frameworks/a/agents/late.md', 'late');
  entries.push(late);
  expect(() => resolve('agent', 'late')).toThrow('Missing agent binding target: late');
  expect(createRuleBindingTargetResolver(entries)('agent', 'late')).toBe(late);
});

it('reads shared graph metadata once per snapshot while retaining separate project entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-binding-snapshot-'));
  try {
    vi.stubEnv('HOME', path.join(root, 'home'));
    vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
    const projects = ['first', 'second'].map(name => path.join(root, name));
    const frameworkFile = path.join(getGraphIndexDir(projects[0], 'framework'), 'metadata.json');
    fs.mkdirSync(path.dirname(frameworkFile), { recursive: true });
    fs.writeFileSync(frameworkFile, JSON.stringify({ entries: { shared: entry('agent',
      'agentic/code/agents/shared.md', 'shared') } }));
    for (const project of projects) {
      const file = path.join(getGraphIndexDir(project, 'project'), 'metadata.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ entries: { local: entry('skill', '.aiwg/skills/local/SKILL.md',
        path.basename(project)) } }));
    }
    const reads = vi.spyOn(fs, 'readFileSync');
    const snapshot = new Map<string, MetadataEntry[]>();
    for (const project of projects) {
      expect(loadLocalCapabilityEntries(project, undefined, snapshot).map(value => value.name).sort())
        .toEqual([path.basename(project), 'shared'].sort());
    }
    expect(reads.mock.calls.filter(args => args[0] === frameworkFile)).toHaveLength(1);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('loads only legitimate legacy project overrides and never the package legacy metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-binding-legacy-'));
  const put = (file: string, entries: MetadataEntry[]) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ entries: Object.fromEntries(entries.map((value, index) => [index, value])) }));
  };
  try {
    for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) vi.stubEnv(key, path.join(root, key));
    for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) vi.stubEnv(key, '');
    const pkg = path.join(root, 'package'), project = path.join(root, 'project');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(pkg, 'agentic/code/frameworks'), { recursive: true });
    fs.mkdirSync(path.join(pkg, 'agentic/code/addons'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"aiwg","version":"1.0.0"}');
    vi.stubEnv('AIWG_ROOT', pkg);
    const packageMetadata = path.join(getProjectIndexRoot(pkg), 'metadata.json');
    put(packageMetadata, [entry('skill', 'agentic/code/addons/example/skills/work/SKILL.md', 'package')]);
    put(path.join(getProjectIndexRoot(project), 'metadata.json'), [
      entry('skill', '.aiwg/skills/work/SKILL.md', 'local'),
      entry('skill', 'agentic/code/addons/example/skills/work/SKILL.md', 'relative-package'),
      entry('skill', path.join(pkg, 'agentic/code/addons/example/skills/work/SKILL.md'), 'absolute-package'),
      entry('skill', '.aiwg/skills/marked/SKILL.md', 'marked-package', 'packaged'),
    ]);
    const reads = vi.spyOn(fs, 'readFileSync');
    expect(loadLocalOverrideCapabilityEntries(project).map(value => value.name)).toEqual(['local']);
    expect(loadLocalOverrideCapabilityEntries(pkg)).toEqual([]);
    expect(reads.mock.calls.some(([file]) => String(file) === packageMetadata)).toBe(false);
    reads.mockRestore();
    put(path.join(getGraphIndexDir(project, 'project'), 'metadata.json'), [entry('skill', '.aiwg/skills/current/SKILL.md', 'current')]);
    expect(loadLocalOverrideCapabilityEntries(project).map(value => value.name)).toEqual(['current']);
  } finally {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true });
  }
});
