import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const scratch = mkdtempSync(path.join(tmpdir(), 'aiwg-b3-plumbing-'));
const home = path.join(scratch, 'home');
const hermesHome = path.join(home, 'hermes-profile');
const temp = path.join(scratch, 'tmp');
for (const dir of [home, hermesHome, temp]) mkdirSync(dir);
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

function inventory(directory: string): Record<string, string> {
  if (!existsSync(directory)) return {};
  return Object.fromEntries(readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(directory, file), createHash('sha256').update(readFileSync(file)).digest('hex')];
    }));
}
// A deploy into cwd by mistake must fail this guard, even for ignored files.
const protectedPaths = ['WORKSPACE.md', 'AIWG.md', 'AGENTS.md', 'CLAUDE.md', '.aiwg/aiwg.config',
  '.claude', '.codex', '.pi', '.hermes', '.agents'];
function repoInventory() {
  return protectedPaths.map(name => {
    const file = path.join(root, name);
    return name.endsWith('.md') || name === '.aiwg/aiwg.config'
      ? [name, existsSync(file) ? readFileSync(file, 'utf8') : null]
      : [name, inventory(file)];
  });
}
const repoBefore = repoInventory();
afterAll(() => {
  try { expect(repoInventory()).toEqual(repoBefore); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
});

function run(cwd: string, args: string[], command = 'use') {
  mkdirSync(cwd, { recursive: true });
  const stdout = path.join(scratch, 'stdout'), stderr = path.join(scratch, 'stderr');
  const outFd = openSync(stdout, 'w'), errFd = openSync(stderr, 'w');
  const result = spawnSync(process.execPath, [path.join(root, 'bin/aiwg.mjs'), command, ...args], {
    cwd, encoding: 'utf8', timeout: 240_000, stdio: ['ignore', outFd, errFd],
    env: { ...process.env, HOME: home, USERPROFILE: home, HERMES_HOME: hermesHome, TMPDIR: temp,
      AIWG_ROOT: root, AIWG_FRAMEWORK_INDEX_CACHE: path.join(scratch, 'framework-cache'),
      AIWG_FRAMEWORK_INDEX_CACHE_SOURCE: root,
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_DATA_HOME: path.join(home, '.local/share'), NO_UPDATE_NOTIFIER: '1' },
  });
  closeSync(outFd);
  closeSync(errFd);
  expect(result.error).toBeUndefined();
  return { code: result.status, output: readFileSync(stdout, 'utf8') + readFileSync(stderr, 'utf8') };
}

describe('B3 use deployment plumbing', () => {
  beforeAll(() => {
    // An installed CLI already has installation identity. Initialize that
    // launcher metadata before asserting that rejected deploys change no home files.
    const result = run(path.join(scratch, 'bootstrap'), [], 'runtime-info');
    expect(result.code, result.output).toBe(0);
  });

  it.each([{ extra: [] }, { extra: ['--dry-run'] }])('refuses Hermes project scope without home writes: $extra (#3461)', ({ extra }) => {
    const before = inventory(home);
    const cwd = path.join(scratch, extra.length ? 'hermes-preview' : 'hermes');
    const result = run(cwd, ['all', '--provider', 'hermes', '--scope', 'project', ...extra]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('Hermes does not support --scope project');
    expect(result.output).toContain('HERMES_HOME/skills');
    expect(inventory(home)).toEqual(before);
    expect(readdirSync(cwd)).toEqual([]);
    expect(existsSync(path.join(hermesHome, 'skills'))).toBe(false);
    expect(existsSync(path.join(home, '.hermes/skills'))).toBe(false);
  }, 240_000);

  it.each(['pi', 'claude'])('preserves sentinel context and absent WORKSPACE.md for %s (#3476)', provider => {
    const cwd = path.join(scratch, provider);
    mkdirSync(cwd);
    // Include existing managed blocks: the opt-out must prevent refresh and cleanup too.
    const sentinel = Buffer.from('SENTINEL\r\n<!-- AIWG:rule-startup:start -->\nOLD RULES\n<!-- AIWG:rule-startup:end -->\n');
    for (const name of ['AGENTS.md', 'AIWG.md']) writeFileSync(path.join(cwd, name), sentinel);
    const args = ['all', '--provider', provider, '--no-context-files', '--force', '--no-hooks'];
    const first = run(cwd, args);
    expect(first.code, first.output).toBe(0);
    for (const name of ['AGENTS.md', 'AIWG.md']) expect(readFileSync(path.join(cwd, name))).toEqual(sentinel);
    expect(existsSync(path.join(cwd, 'WORKSPACE.md'))).toBe(false);
    // Existing WORKSPACE.md must also remain byte-identical on redeploy.
    writeFileSync(path.join(cwd, 'WORKSPACE.md'), sentinel);
    const second = run(cwd, args);
    expect(second.code, second.output).toBe(0);
    for (const name of ['AGENTS.md', 'AIWG.md', 'WORKSPACE.md']) expect(readFileSync(path.join(cwd, name))).toEqual(sentinel);
    const rules = inventory(path.join(cwd, `.${provider}/rules`));
    expect(Object.keys(rules)).toContain('RULES-INDEX.md');
  }, 480_000);

  it('uses the source package version for addon skills, rules and generated indexes (#3459)', () => {
    const cwd = path.join(scratch, 'addon');
    const result = run(cwd, ['aiwg-utils', '--provider', 'claude', '--force', '--no-hooks', '--no-context-files']);
    expect(result.code, result.output).toBe(0);
    let markers = 0;
    for (const name of Object.keys(inventory(path.join(cwd, '.claude')))) {
      if (!/\.(md|mdc)$/.test(name)) continue;
      const content = readFileSync(path.join(cwd, '.claude', name), 'utf8');
      for (const marker of content.matchAll(/aiwg:managed v(\S+) (\S+)/g)) {
        expect(marker[1], name).toBe(version);
        expect(marker[2], name).toBe('bundled');
        markers++;
      }
    }
    expect(markers).toBeGreaterThan(12);
    expect(readFileSync(path.join(cwd, '.claude/rules/RULES-INDEX.md'), 'utf8')).toContain(`aiwg:managed v${version} bundled`);
    expect(result.output).not.toContain('Unable to resolve AIWG deploy version');
  }, 240_000);
});
