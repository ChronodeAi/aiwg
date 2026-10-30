import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = path.resolve('bin/aiwg.mjs');
let temp: string;
let workspace: string;
let env: NodeJS.ProcessEnv;
function write(relative: string, content: string): void {
  const target = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function snapshot(root: string): unknown[] {
  return fs.readdirSync(root).sort().map(name => {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    return [name, stat.mode, stat.mtimeMs, stat.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('base64')];
  });
}
function run(args: string[]): string {
  const result = spawnSync(process.execPath, [cli, 'memory', ...args], { cwd: workspace, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  expect(result.error).toBeUndefined();
  expect(['audit', 'cost', 'recommend'].includes(args[0]) ? [0, 1] : [0]).toContain(result.status);
  return result.stdout;
}
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-memory-audit-cli-'));
  workspace = path.join(temp, 'workspace');
  const home = path.join(temp, 'home');
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  env = { ...process.env, HOME: home, USERPROFILE: home, AIWG_CONFIG: path.join(home, '.aiwg'), AIWG_CLI_DRY_RUN: '', AIWG_PROJECT_MEMORY_HOME: path.join(home, '.aiwg/projects'),
    HERMES_HOME: path.join(home, '.hermes'), XDG_CONFIG_HOME: path.join(home, '.config'),
    AIWG_ARTIFACTS_PATH: '', AIWG_PROJECT_ARTIFACTS_PATH: '', AIWG_PROJECT_AIWG_DIR: '', AIWG_GROKBOT_SKILLS_DIR: '',
    GROK_HOME: '', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', PI_CONFIG_DIR: '', PI_CODING_AGENT_DIR: '', OMP_PROFILE: '', PI_PROFILE: '',
    NO_COLOR: '1' };
});
afterEach(() => { fs.rmSync(temp, { recursive: true, force: true }); });

describe('built memory audit CLI', () => {
  it('emits versioned JSON and human output without mutating either workspace or home', () => {
    write('CLAUDE.md', '@WORKSPACE.md');
    write('WORKSPACE.md', 'Synthetic workspace context');
    write('.aiwg/memory/line-memory.txt', 'Synthetic fact');
    write('.aiwg/aiwg.config', JSON.stringify({ version: '1', command_log: { enabled: true, scopes: ['project', 'global'] }, telemetry: { skill_usage: { enabled: true, scopes: ['project', 'global'] } } }));
    const before = snapshot(temp);
    const report = JSON.parse(run(['audit', '--provider', 'claude', '--json']));
    expect(report.schemaVersion).toBe('aiwg.memory-audit.v1');
    expect(report.scope).toBe('workspace');
    expect(report.items.find((item: { sourcePath: string }) => item.sourcePath === 'WORKSPACE.md').exposures.length).toBeGreaterThan(1);
    expect(run(['audit', '--scope', 'project', '--provider', 'codex'])).toContain('Static inventory');
    expect(snapshot(temp)).toEqual(before);
  });

  it('advertises audit in memory help and rejects unknown flags and missing selections', () => {
    expect(run(['--help'])).toContain('memory audit');
    expect(run(['audit', '--help'])).toContain('--scope global|project|provider');
    for (const args of [['--write'], ['--scope', 'provider'], ['--scope', 'global', '--unknown'], ['--provider', 'does-not-exist']]) {
      const result = spawnSync(process.execPath, [cli, 'memory', 'audit', ...args], { cwd: workspace, env, encoding: 'utf8', timeout: 30000 });
      expect(result.status).toBe(2);
      expect(result.stdout + result.stderr).toMatch(/memory command failed|memory audit|Unknown memory provider/);
    }
  });
  it('uses success and findings statuses consistently for the read-only report family', () => {
    const invoke = (command: string, provider: string) => spawnSync(process.execPath,
      [cli, 'memory', command, '--scope', 'provider', '--provider', provider, '--json'],
      { cwd: workspace, env, encoding: 'utf8', timeout: 30000 });
    for (const command of ['audit', 'cost', 'recommend']) {
      const clean = invoke(command, 'generic');
      expect(clean.status, clean.stdout + clean.stderr).toBe(0);
      expect(JSON.parse(clean.stdout)).toHaveProperty('schemaVersion');
    }
    write('.claude/rules/one.md', 'Synthetic duplicate constraint');
    write('.claude/rules/two.md', 'Synthetic duplicate constraint');
    const before = snapshot(temp);
    for (const command of ['audit', 'cost', 'recommend']) {
      const findings = invoke(command, 'claude');
      expect(findings.status, findings.stdout + findings.stderr).toBe(1);
      expect(JSON.parse(findings.stdout)).toHaveProperty('schemaVersion');
    }
    expect(snapshot(temp)).toEqual(before);
  });

});
