import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Windsurf's AGENTS.md is both its always-loaded startup file and the agent
// aggregate. Under CI the rules budget is strict, so the aggregate must not be
// counted as rule content, while the managed rule content still is.
const root = path.resolve(import.meta.dirname, '../../..');
const scratch = mkdtempSync(path.join(tmpdir(), 'aiwg-windsurf-budget-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function deploy(name, env = {}) {
  const home = path.join(scratch, `${name}-home`);
  const target = path.join(scratch, name);
  mkdirSync(home); mkdirSync(target);
  const result = spawnSync(process.execPath, [path.join(root, 'tools/agents/deploy-agents.mjs'),
    '--provider', 'windsurf', '--mode', 'sdlc', '--target', target,
    '--deploy-commands', '--deploy-skills', '--deploy-rules', '--copy-all'], {
    cwd: target, encoding: 'utf8', timeout: 240_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'),
      NO_UPDATE_NOTIFIER: '1', CI: '1', AIWG_RULES_INLINE_BUDGET_TOKENS: undefined, ...env },
  });
  return { ...result, output: `${result.stdout}${result.stderr}`, target };
}

describe('Windsurf aggregate rule budget', () => {
  it('deploys the full agent aggregate under the strict CI budget', () => {
    const result = deploy('aggregate');
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain('Rules startup budget exceeded');
    // The aggregate itself is far larger than the 64,000-token rules budget.
    expect(statSync(path.join(result.target, 'AGENTS.md')).size).toBeGreaterThan(256_000);
  }, 300_000);

  it('still budgets the rule content of AGENTS.md', () => {
    const result = deploy('tiny-budget', { AIWG_RULES_INLINE_BUDGET_TOKENS: '1' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('Rules startup budget exceeded for windsurf');
  }, 300_000);
});
