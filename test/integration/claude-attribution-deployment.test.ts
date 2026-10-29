// Exercise the public Claude use boundary without invoking the Claude binary.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
let root: string;
let home: string;
let project: string;
const defaults = { commit: '', pr: '', sessionUrl: false };
const settings = (dir: string) => JSON.parse(readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'));
function seed(dir: string, value: object) {
  mkdirSync(path.join(dir, '.claude'), { recursive: true });
  writeFileSync(path.join(dir, '.claude/settings.json'), JSON.stringify(value));
}
function use(extra: string[] = []) {
  const result = spawnSync(process.execPath, [path.join(repo, 'bin/aiwg.mjs'), 'use', 'sdlc',
    '--provider', 'claude', '--target', project, '--scope', 'user', '--no-hooks',
    '--no-utils', '--copy-all', '--no-context-files', '--no-workspace-signals', '--non-interactive', ...extra], {
    cwd: project, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, AIWG_ROOT: repo,
      AIWG_CONFIG: path.join(home, '.aiwg'), AIWG_USER_REGISTRY_PATH: path.join(home, '.aiwg/installed.json'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local/state'),
      AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1' },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout + result.stderr;
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aiwg-claude-attribution-deploy-'));
  home = path.join(root, 'home'); project = path.join(root, 'project');
  mkdirSync(home); mkdirSync(project);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe('Claude attribution deployment (#3750)', () => {
  it('merges user and project defaults without hooks and preserves the original backup', () => {
    seed(project, { attribution: { commit: '' }, operator: true });
    seed(home, { attribution: { pr: 'User PR' } });
    const output = use();
    expect(settings(project).attribution).toEqual(defaults);
    expect(settings(home).attribution).toEqual({ ...defaults, pr: 'User PR' });
    expect(output).toContain('Preserved operator attribution.pr');
    const backups = readdirSync(path.join(project, '.claude')).filter(name => name.includes('.bak.'));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(project, '.claude', backups[0]), 'utf8')))
      .toEqual({ attribution: { commit: '' }, operator: true });
    const before = settings(project);
    use();
    expect(settings(project)).toEqual(before);
    expect(readdirSync(path.join(project, '.claude')).filter(name => name.includes('.bak.'))).toEqual(backups);
  }, 240_000);
  it('keeps attribution untouched with opt-out across provider passes and user scope', () => {
    seed(project, { attribution: { commit: 'Operator commit' } });
    seed(home, { attribution: { pr: 'User PR' } });
    use(['--no-attribution']);
    expect(settings(project).attribution).toEqual({ commit: 'Operator commit' });
    expect(settings(home).attribution).toEqual({ pr: 'User PR' });
    expect(settings(project).aiwg?.attributionKeys).toBeUndefined();
  }, 120_000);
  it('dry-run preserves existing project and user attribution', () => {
    seed(project, { operator: true }); seed(home, { operator: true });
    use(['--dry-run']);
    expect(settings(project)).toEqual({ operator: true });
    expect(settings(home)).toEqual({ operator: true });
    expect(readdirSync(path.join(project, '.claude'))).toEqual(['settings.json']);
  }, 120_000);
});
