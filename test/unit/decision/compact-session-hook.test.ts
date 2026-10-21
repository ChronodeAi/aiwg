import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let root: string;
const hook = resolve(__dirname, '../../../agentic/code/addons/aiwg-hooks/hooks/aiwg-session.cjs');
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-compact-hook-'));
  const dir = join(root, 'dist/src/decision');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'offload-activation.js'), 'export const DECISION_COMPACT_ANCHOR = "fixture pointer"; export async function inspectDecisionOffloadActivation() { return { shouldAnchor: process.env.FIXTURE_ENABLED === "1" }; }');
});

it('ignores oversized hook input without parsing or invoking activation', () => {
  const child = spawnSync(process.execPath, [hook], { cwd: root, env: { ...process.env, AIWG_ROOT: root, FIXTURE_ENABLED: '1' },
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', padding: 'x'.repeat(65536) }), encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toBe('');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('injects only for compact SessionStart with enabled shared activation; other events remain silent', () => {
  for (const [event, enabled, expected] of [
    [{ hook_event_name: 'SessionStart', source: 'compact' }, '1', 'fixture pointer\n'],
    [{ hook_event_name: 'SessionStart', source: 'startup' }, '1', ''],
    [{ hook_event_name: 'SessionStart', source: 'resume' }, '1', ''],
    [{ hook_event_name: 'PreToolUse', source: 'compact' }, '1', ''],
    [{ hook_event_name: 'SessionStart', source: 'compact' }, '0', ''],
  ] as const) {
    const child = spawnSync(process.execPath, [hook], { cwd: root, env: { ...process.env, AIWG_ROOT: root, FIXTURE_ENABLED: enabled },
      input: JSON.stringify(event), encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe(expected);
  }
});
