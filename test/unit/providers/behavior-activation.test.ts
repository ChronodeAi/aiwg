import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from 'js-yaml';
import { collectBehaviorDirs, deployEmulatedBehaviors } from '../../../tools/agents/providers/base.mjs';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { findArtifactFiles } from '../../../src/artifacts/index-files.js';
import type { ArtifactIndex } from '../../../src/artifacts/types.js';

const root = path.resolve(import.meta.dirname, '../../..');
const adr = fs.readFileSync(path.join(root, 'docs/architecture/adr-rule-activation-and-bound-delivery.md'), 'utf8');
const map = load(adr.split('## Machine-readable starting map')[1].match(/```yaml\n([\s\S]*?)```/)![1]) as any;
const dirs: string[] = collectBehaviorDirs(root);
const frontmatter = (content: string) => load(content.match(/^---\n([\s\S]*?)\n---/)![1]) as Record<string, any>;

// Temporary ADR contract adapter. Replace this function with #2938's
// parseRuleFrontmatter / validateRuleFrontmatter once src/rules/activation.mjs lands.
function validateActivation(data: Record<string, any>): void {
  const mode = data.activation;
  if (!['kernel', 'summary', 'bound', 'paths', 'on-demand'].includes(mode)) throw Error('activation');
  if (data.summary !== undefined || ['summary', 'bound', 'paths'].includes(mode)) {
    if (typeof data.summary !== 'string' || !data.summary.trim() || /[\r\n]/.test(data.summary) ||
      [...data.summary.trim()].length > 240) throw Error('summary');
  }
  let targets = 0;
  if (data.bound_to !== undefined) {
    if (['kernel', 'on-demand'].includes(mode) || !data.bound_to ||
      typeof data.bound_to !== 'object' || Array.isArray(data.bound_to)) throw Error('bound_to');
    for (const [kind, ids] of Object.entries(data.bound_to)) {
      if (!['agents', 'skills', 'flows'].includes(kind) || !Array.isArray(ids) ||
        ids.some(id => typeof id !== 'string' || !id.trim())) throw Error('bound_to');
      targets += ids.length;
    }
  }
  if (mode === 'bound' && !targets) throw Error('bound_to');
  if (mode === 'paths') {
    if (!Array.isArray(data.paths) || !data.paths.length || data.paths.some((glob: unknown) =>
      typeof glob !== 'string' || !glob.trim() || path.posix.isAbsolute(glob) ||
      /^[A-Za-z]:/.test(glob) || glob.includes('\\') || glob.split('/').includes('..'))) throw Error('paths');
  } else if (data.paths !== undefined) throw Error('paths');
}

describe('canonical behavior activation (#3222)', () => {
  let tmp: string;
  let index: ArtifactIndex;
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-behavior-activation-'));
    // Index actual canonical definitions, without generated plugin duplicates or git calls.
    const sources = findArtifactFiles(path.join(root, 'agentic/code')).filter(file =>
      !file.includes('/plugins/') && (/\/agents\/[^/]+\.md$/.test(file) || file.endsWith('/build-artifact-index/SKILL.md')));
    for (const file of sources) {
      const dest = path.join(tmp, path.relative(root, file));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
    }
    await buildIndex(tmp, { scope: 'agentic/code', includeIgnored: true, outputDir: path.join(tmp, 'index'), force: true, quiet: true });
    index = JSON.parse(fs.readFileSync(path.join(tmp, 'index/.aiwg/.index/metadata.json'), 'utf8'));
  }, 30000);
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('covers every collected behavior with the normative ADR inventory', () => {
    expect(dirs.map(dir => path.basename(dir)).sort()).toEqual(Object.keys(map.behaviors.entries).sort());
  });

  for (const dir of dirs) {
    const name = path.basename(dir);
    it(`${name} declares the ADR activation and resolves every target in the artifact index`, () => {
      const expected = map.behaviors.entries[name];
      expect(path.relative(path.join(root, 'agentic/code'), dir)).toBe(`${map.behaviors.source_roots[expected.source]}/${name}`);
      const data = frontmatter(fs.readFileSync(path.join(dir, 'BEHAVIOR.md'), 'utf8'));
      validateActivation(data);
      expect(data.activation).toBe(expected.activation);
      expect(data.bound_to).toEqual(expected.bound_to);
      if (data.activation === 'kernel') expect(fs.readFileSync(path.join(dir, 'BEHAVIOR.md'), 'utf8')).toMatch(/<!--[^]*kernel[^]*-->/);
      for (const [kind, ids] of Object.entries(data.bound_to ?? {}) as [string, string[]][]) {
        for (const id of ids) {
          const type = { agents: 'agent', skills: 'skill', flows: 'flow' }[kind];
          // Same exact name / file-stem / skill-directory selectors used by showArtifact.
          const matches = Object.values(index.entries).filter(entry => entry.type === type &&
            (entry.name === id || path.basename(entry.path, '.md') === id ||
             (entry.path.endsWith('/SKILL.md') && path.basename(path.dirname(entry.path)) === id)));
          expect(matches.map(entry => entry.path), `${kind}:${id}`).toHaveLength(1);
        }
      }
    });
  }

  it('preserves all eight Claude behavior deployments during transition', () => {
    expect(deployEmulatedBehaviors(dirs, 'claude', tmp, { deployVersion: '3222', deploySource: 'bundled' })).toBe(dirs.length);
    for (const dir of dirs) {
      const output = fs.readFileSync(path.join(tmp, '.claude/rules/behaviors', `${path.basename(dir)}.md`), 'utf8');
      expect(output).toContain(fs.readFileSync(path.join(dir, 'BEHAVIOR.md'), 'utf8').trim());
    }
  });

  it.each([
    {}, { activation: 'bound + paths' }, { activation: ['bound'] },
    { activation: 'bound', summary: 'Fetch policy.' },
    { activation: 'bound', summary: 'x'.repeat(241), bound_to: { agents: ['concierge'] } },
    { activation: 'bound', summary: 'two\nlines', bound_to: { agents: ['concierge'] } },
    { activation: 'bound', summary: ' ', bound_to: { agents: ['concierge'] } },
    { activation: 'bound', summary: 'Fetch policy.', bound_to: { bots: ['concierge'] } },
    { activation: 'bound', summary: 'Fetch policy.', bound_to: { agents: [''] } },
    { activation: 'kernel', bound_to: { agents: ['concierge'] } },
    { activation: 'on-demand', paths: ['src/**'] },
    { activation: 'paths', summary: 'Check files.', paths: ['../secret'] },
  ])('rejects invalid ADR metadata: %j', data => {
    expect(() => validateActivation(data)).toThrow();
  });
});
