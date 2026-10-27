// Deploy only into private synthetic projects; execute the generated hook with fake tool events.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkWorkerHealthReadiness } from '../../../tools/cli/doctor-worker-health.mjs';
import { postDeploy as claudePostDeploy } from '../../../tools/agents/providers/claude.mjs';
import { postDeploy as codexPostDeploy } from '../../../tools/agents/providers/codex.mjs';

let root: string;
const json = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const hook = (input: unknown) => spawnSync(process.execPath, [path.join(root, '.claude/hooks/aiwg-local-only.mjs')], {
  input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', cwd: root, timeout: 10000,
});
const event = (tool_name: string, tool_input: object) => ({ tool_name, tool_input, cwd: root });
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aiwg-data-guard-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('AIWG_CONFIG', path.join(root, 'user-config'));
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  mkdirSync(path.join(root, 'eval-work'));
  writeFileSync(path.join(root, 'eval-work/local.txt'), 'SYNTHETIC-PRIVATE-CONTENT');
  writeFileSync(path.join(root, 'models.json'), JSON.stringify({ defaults: { workerSelection: {
    dataClasses: { 'local-only': { allowedProcessing: ['local'], localOnlyPaths: ['eval-work/local.txt'] } },
  } } }));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('T-OG-01 conductor data guard provider deployment', () => {
  it('Claude installs refusals, preserves operator settings and is idempotent', async () => {
    mkdirSync(path.join(root, '.claude'));
    writeFileSync(path.join(root, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(pwd)'], deny: ['Read(.env)'] },
      hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'operator-hook' }] }] } }));
    await claudePostDeploy(root, { contextFiles: false });
    await claudePostDeploy(root, { contextFiles: false });
    const settings = json('.claude/settings.json');
    expect(settings.permissions.allow).toEqual(['Bash(pwd)']);
    expect(settings.permissions.deny).toContain('Read(.env)');
    expect(settings.permissions.deny).toContain(`Read(/${root}/eval-work/local.txt)`);
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    const denied = hook(event('Bash', { command: 'ls -la . && cat eval-work/local.txt 2>/dev/null | head -5 && pwd' }));
    expect(denied.status, denied.stderr).toBe(0);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denied.stdout).not.toContain('SYNTHETIC-PRIVATE-CONTENT');
    const read = hook(event('Read', { file_path: path.join(root, 'eval-work/local.txt') }));
    expect(JSON.parse(read.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    const allowed = hook(event('Bash', { command: 'cat README.md' }));
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(allowed.stdout).toBe('');
    expect(hook('invalid-json').status).toBe(2);
  });
  it('deploys without any model config when no local-only paths are declared', async () => {
    // The slim CLI package ships no framework default models config; an ordinary
    // deploy must not need it.
    rmSync(path.join(root, 'models.json'));
    vi.stubEnv('AIWG_HOME', mkdtempSync(path.join(root, 'no-defaults-')));
    await expect(claudePostDeploy(root, { contextFiles: false })).resolves.not.toThrow();
    await expect(codexPostDeploy(root, { contextFiles: false })).resolves.not.toThrow();
    expect(() => readFileSync(path.join(root, '.claude/hooks/aiwg-local-only.mjs'))).toThrow();
    expect(() => readFileSync(path.join(root, '.codex/rules/aiwg-local-only.rules'))).toThrow();
  });
  it('Codex emits forbidden explicit reader prefixes in project rules', async () => {
    await codexPostDeploy(root, { contextFiles: false });
    const rules = readFileSync(path.join(root, '.codex/rules/aiwg-local-only.rules'), 'utf8');
    expect(rules).toContain('prefix_rule(pattern = ["cat","eval-work/local.txt"], decision = "forbidden")');
    expect(rules).toContain(JSON.stringify(['cat', path.join(root, 'eval-work/local.txt')]));
    expect(rules).not.toContain('SYNTHETIC-PRIVATE-CONTENT');
  });
  it('doctor reports protected paths when dispatch is disabled', async () => {
    const check = vi.fn();
    await checkWorkerHealthReadiness({ config: null, configFailed: false, AIWG_ROOT: process.cwd(), cwd: root, check });
    expect(check.mock.calls.some(call => call[2].includes('eval-work/local.txt'))).toBe(true);
  });
  it('dry-run writes no settings or hooks', async () => {
    await claudePostDeploy(root, { contextFiles: false, dryRun: true });
    expect(() => json('.claude/settings.json')).toThrow();
  });
  it('invalid path declarations fail deployment before publishing a hook', async () => {
    writeFileSync(path.join(root, 'models.json'), JSON.stringify({ defaults: { workerSelection: { dataPolicy: { localOnlyPaths: ['../secret'] } } } }));
    await expect(claudePostDeploy(root, { contextFiles: false })).rejects.toThrow();
    expect(() => json('.claude/settings.json')).toThrow();
  });
});
