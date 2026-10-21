import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNormalizedAiwgMd } from '../../../src/smiths/context-pipeline/finalization.js';
import { inspectDecisionOffloadActivation, DECISION_COMPACT_ANCHOR } from '../../../src/decision/offload-activation.js';

let root: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-decision-anchor-'));
  saved = Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'AIWG_CONFIG', 'AIWG_USER_REGISTRY_PATH', 'AIWG_DECISION_ENABLED', 'JEV_API_KEY', 'AIWG_DECISION_JEV_API_KEY'].map(key => [key, process.env[key]]));
  process.env.HOME = join(root, 'home');
  process.env.XDG_CONFIG_HOME = join(root, 'xdg');
  process.env.AIWG_CONFIG = join(root, 'config');
  process.env.AIWG_USER_REGISTRY_PATH = join(root, 'user-registry.json');
  delete process.env.AIWG_DECISION_ENABLED;
  delete process.env.JEV_API_KEY;
  delete process.env.AIWG_DECISION_JEV_API_KEY;
  mkdirSync(join(root, '.aiwg'), { recursive: true });
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
});

function project(installed: boolean, enabled?: boolean) {
  writeFileSync(join(root, '.aiwg/aiwg.config'), JSON.stringify({ installed: installed ? { 'decision-engine': { version: '1', source: 'bundled', deployedTo: {} } } : { all: { version: '1', source: 'bundled', deployedTo: {} } }, ...(enabled === undefined ? {} : { decision: { enabled } }) }));
}
function fakeSavedOptIn() {
  const dir = join(root, 'xdg/aiwg/credentials');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, 'jev.json'), JSON.stringify({ token: 'fake-test-only', enabled: true }), { mode: 0o600 });
}

describe('decision compaction activation', () => {
  it('retains an enabled saved ask across fresh and regenerated context without claiming native load', async () => {
    project(true); fakeSavedOptIn();
    const state = await inspectDecisionOffloadActivation({ cwd: root });
    expect(state).toMatchObject({ shouldAnchor: true, askEnabled: true, evaluateEnabled: false, nativeActivation: 'not-claimed' });
    expect(JSON.stringify(state)).not.toContain('fake-test-only');
    const fresh = await buildNormalizedAiwgMd(root, '# Operator\n\nKeep this note.\n');
    expect(fresh).toContain(DECISION_COMPACT_ANCHOR);
    expect(fresh).toContain('## Compact Instructions');
    expect(fresh).toContain('Keep this note.');
    expect((await buildNormalizedAiwgMd(root, fresh)).split(DECISION_COMPACT_ANCHOR)).toHaveLength(2);
    project(true, false);
    const disabled = await buildNormalizedAiwgMd(root, fresh);
    expect(disabled).not.toContain(DECISION_COMPACT_ANCHOR);
    expect(disabled).toContain('Keep this note.');
  });
  it('recognizes explicit user-scope addon registration', async () => {
    project(false); fakeSavedOptIn();
    writeFileSync(join(root, 'user-registry.json'), JSON.stringify({ version: '1', installed: { 'decision-engine': { version: '1', source: 'bundled', deployedTo: {} } } }));
    expect((await inspectDecisionOffloadActivation({ cwd: root })).shouldAnchor).toBe(true);
  });
  it('requires explicit addon installation and honors an environment disable', async () => {
    project(false); fakeSavedOptIn();
    expect((await inspectDecisionOffloadActivation({ cwd: root })).shouldAnchor).toBe(false);
    project(true);
    process.env.AIWG_DECISION_ENABLED = '0';
    expect((await inspectDecisionOffloadActivation({ cwd: root })).shouldAnchor).toBe(false);
    expect(readFileSync(join(root, 'xdg/aiwg/credentials/jev.json'), 'utf8')).toContain('fake-test-only');
  });
  it('uses explicit project and environment precedence over a saved opt-in', async () => {
    project(true, false); fakeSavedOptIn();
    expect((await inspectDecisionOffloadActivation({ cwd: root })).shouldAnchor).toBe(false);
    process.env.AIWG_DECISION_ENABLED = '1';
    expect((await inspectDecisionOffloadActivation({ cwd: root })).shouldAnchor).toBe(true);
    process.env.AIWG_DECISION_ENABLED = '0';
    project(true, true);
    expect((await inspectDecisionOffloadActivation({ cwd: root })).shouldAnchor).toBe(false);
  });
  it('does not emit an anchor when ask is enabled but no credential is configured', async () => {
    project(true, true);
    const state = await inspectDecisionOffloadActivation({ cwd: root });
    expect(state.askEnabled).toBe(false);
    expect(state.shouldAnchor).toBe(false);
  });
  it('does not infer rule delivery or native loading from canonical source presence', async () => {
    project(true); fakeSavedOptIn();
    const source = join(root, 'framework/agentic/code/addons/decision-engine/rules');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'decision-offload.md'), 'fixture rule');
    const state = await inspectDecisionOffloadActivation({ cwd: root, frameworkRoot: join(root, 'framework') });
    expect(state).toMatchObject({ ruleSourcePresent: true, ruleDelivery: 'unknown', startupAnchorPresent: false, nativeActivation: 'not-claimed' });
  });
  it('fails closed when saved credential metadata is invalid', async () => {
    project(true); fakeSavedOptIn();
    writeFileSync(join(root, 'xdg/aiwg/credentials/jev.json'), '{bad json');
    const state = await inspectDecisionOffloadActivation({ cwd: root });
    expect(state.askEnabled).toBeNull();
    expect(state.shouldAnchor).toBe(false);
    expect(state.nativeActivation).toBe('not-claimed');
  });
});
