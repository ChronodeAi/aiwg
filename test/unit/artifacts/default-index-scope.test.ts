import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { main } from '../../../src/artifacts/cli.js';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { collectGraphIndexFiles } from '../../../src/artifacts/index-files.js';
import { queryIndex } from '../../../src/artifacts/query-engine.js';

/** @implements #3146 */
describe('default artifact index scope', () => {
  let fixture: string;
  let root: string;
  const canonical = '.aiwg/references/REF-2784-pipnn.md';
  const ignored = '.aiwg/scratch/draft.md';

  function write(relative: string, content = '# Turbocharging PiPNN workshop\n'): void {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  function indexed(graph = 'project'): string[] {
    const file = path.join(root, '.aiwg', '.index', graph, 'metadata.json');
    return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).entries);
  }

  beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-index-scope-'));
    root = path.join(fixture, 'project');
    fs.mkdirSync(root);
    vi.stubEnv('HOME', path.join(fixture, 'home'));
    vi.stubEnv('XDG_DATA_HOME', path.join(fixture, 'data'));
    for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR', 'AIWG_PROJECT_LOCAL_PATHS']) {
      vi.stubEnv(key, '');
    }
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    execFileSync('git', ['init', '-q'], { cwd: root, timeout: 60_000 });
    write('.gitignore', '.aiwg/scratch/\n');
    write(canonical);
    write(ignored);
    for (const dir of ['working', 'sessions', '.index']) write(`.aiwg/${dir}/draft.md`);
    const sibling = path.join(fixture, 'sibling');
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'outside.md'), '# Turbocharging PiPNN workshop\n');
    fs.symlinkSync(sibling, path.join(root, '.aiwg', 'linked-outside'), 'dir');
    fs.symlinkSync(path.join(root, '.aiwg', 'references'), path.join(root, '.aiwg', 'duplicate'), 'dir');
    fs.symlinkSync(path.join(root, canonical), path.join(root, '.aiwg', 'alias.md'));
    fs.symlinkSync(path.join(root, '.aiwg'), path.join(root, '.aiwg', 'loop'), 'dir');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  it('build --all keeps canonical documents first in queries without --graph', async () => {
    await main(['build', '--all']);
    expect(indexed()).toEqual([canonical]);
    await queryIndex(root, { text: 'Turbocharging PiPNN workshop' }, { json: true });
    const result = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string);
    expect(result.results[0].path).toBe(canonical);
    expect(result.total).toBe(1);
  });

  for (const args of [[], ['--all'], ['--graph', 'project']]) {
    it(`includes ignored sources only with the CLI opt-in (${args.join(' ') || 'default'})`, async () => {
      await main(['build', ...args, '--include-ignored']);
      expect(indexed().sort()).toEqual([canonical, ignored].sort());
      // An ordinary incremental rebuild also removes previously indexed scratch.
      await buildIndex(root, { graph: 'project' });
      expect(indexed()).toEqual([canonical]);
    });
  }

  it('keeps indexing when the whole artifact root is gitignored', async () => {
    write('.gitignore', '.aiwg/\n');
    await main(['build', '--all']);
    // An ignored root would otherwise empty the index; runtime dirs and
    // symlinks stay excluded.
    expect(indexed().sort()).toEqual([canonical, ignored].sort());
  });

  it('enforces exclusions and symlink policy for explicit scopes and scan roots', async () => {
    write('.aiwg/references/nested/doc.md');
    for (const scope of ['.aiwg/working', '.aiwg/sessions', '.aiwg/.index', '.aiwg/linked-outside', '.aiwg/duplicate', '.aiwg/duplicate/nested']) {
      expect(await collectGraphIndexFiles(root, 'project', { scope, includeIgnored: true })).toEqual([]);
    }
    await buildIndex(root, { scope: '.aiwg/scratch', graph: 'project' });
    expect(indexed()).toEqual([]);
    await buildIndex(root, { scope: '.aiwg/scratch', graph: 'project', includeIgnored: true });
    expect(indexed()).toEqual([ignored]);
    await buildIndex(root, { scope: '.aiwg/working', graph: 'project', includeIgnored: true });
    expect(indexed()).toEqual([]);
  });

  it('applies the same policy to the legacy default index and coverage enumeration', async () => {
    await buildIndex(root);
    const metadata = path.join(root, '.aiwg', '.index', 'metadata.json');
    expect(Object.keys(JSON.parse(fs.readFileSync(metadata, 'utf8')).entries)).toEqual([canonical]);
    expect(await collectGraphIndexFiles(root)).toEqual([path.join(root, canonical)]);
  });

  it('filters workspace-linked sources through the same ignore and runtime policy', async () => {
    write('WORKSPACE.md', [
      '[canonical](.aiwg/references/REF-2784-pipnn.md)',
      '[scratch](.aiwg/scratch/draft.md)',
      '[working](.aiwg/working/draft.md)',
      '[session](.aiwg/sessions/draft.md)',
      '[index](.aiwg/.index/draft.md)',
      '[symlink](.aiwg/alias.md)',
    ].join('\n'));
    const expected = [path.join(root, canonical), path.join(root, 'WORKSPACE.md')];
    expect(await collectGraphIndexFiles(root, 'project')).toEqual(expected);
    expect(await collectGraphIndexFiles(root, 'project', { includeIgnored: true }))
      .toEqual([path.join(root, canonical), path.join(root, ignored), path.join(root, 'WORKSPACE.md')]);
  });

  it('excludes runtime directories under a configured external artifact root', async () => {
    const store = path.join(fixture, 'artifact-store');
    fs.mkdirSync(path.join(store, 'references'), { recursive: true });
    fs.writeFileSync(path.join(store, 'references', 'canonical.md'), '# Canonical\n');
    for (const name of ['working', 'sessions', '.index']) {
      fs.mkdirSync(path.join(store, name), { recursive: true });
      fs.writeFileSync(path.join(store, name, 'draft.md'), '# Scratch\n');
    }
    execFileSync('git', ['init', '-q'], { cwd: store, timeout: 60_000 });
    fs.writeFileSync(path.join(store, '.gitignore'), 'references/draft.md\n');
    fs.writeFileSync(path.join(store, 'references', 'draft.md'), '# Draft\n');
    vi.stubEnv('AIWG_PROJECT_AIWG_DIR', store);
    expect(await collectGraphIndexFiles(root, 'project'))
      .toEqual([path.join(store, 'references', 'canonical.md')]);
    expect(await collectGraphIndexFiles(root, 'project', { includeIgnored: true }))
      .toEqual(['canonical.md', 'draft.md'].map(name => path.join(store, 'references', name)));
  });

  it('documents the opt-in and exclusions in build help', async () => {
    await main(['build', '--help']);
    const output = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(output).toContain('--include-ignored');
    expect(output).toContain('runtime directories stay excluded');
    expect(output).toContain('skips symlinks');
  });
});
