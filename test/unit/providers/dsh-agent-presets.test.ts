/**
 * Unit tests: dsh provider agent-presets deployment (#1707).
 *
 * deployAgentPresets copies corpus preset directories (agent.cordis.yml +
 * preset.yml) into the DeepSeek Harness agent-preset user root
 * ($DSH_HOME|~/.dsh)/.agent-presets/, where dsh-agent-presets discovers them
 * live. Both roots are injectable so tests never touch the operator's real
 * harness home.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PROVIDER_DIR = path.resolve(process.cwd(), 'tools/agents/providers');
const CORPUS_PRESETS = path.join(PROVIDER_DIR, 'dsh', 'agent-presets');

async function loadModule() {
  // Fresh module instance per test so the once-per-process memo resets.
  return import(`${PROVIDER_DIR}/dsh.mjs?test=${Date.now()}-${Math.random()}`);
}

let tmp;
let dshHome;
let sourceDir;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'aiwg-dsh-presets-'));
  dshHome = path.join(tmp, 'dsh-home');
  // Mirror the corpus layout with two minimal-but-valid presets.
  sourceDir = path.join(tmp, 'presets-src');
  for (const id of ['aiwg-coding-worker', 'aiwg-reasoning-worker']) {
    mkdirSync(path.join(sourceDir, id), { recursive: true });
    writeFileSync(path.join(sourceDir, id, 'agent.cordis.yml'), `- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: ${id}\n`);
    writeFileSync(path.join(sourceDir, id, 'preset.yml'), `name: "${id}"\ndescription: "test"\n`);
  }
  // An extra file that must NOT be copied (only the two contract files ship).
  writeFileSync(path.join(sourceDir, 'aiwg-coding-worker', 'README.md'), 'ignored\n');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('dsh provider deployAgentPresets', () => {
  it('deploys every corpus preset directory into the DSH_HOME user root', async () => {
    const mod = await loadModule();
    const destRoot = path.join(dshHome, '.agent-presets');
    const n = mod.deployAgentPresets({ quiet: true, presetSourceDir: sourceDir, presetDestRoot: destRoot });
    expect(n).toBe(2);
    for (const id of ['aiwg-coding-worker', 'aiwg-reasoning-worker']) {
      expect(existsSync(path.join(destRoot, id, 'agent.cordis.yml'))).toBe(true);
      expect(existsSync(path.join(destRoot, id, 'preset.yml'))).toBe(true);
      expect(existsSync(path.join(destRoot, id, 'README.md'))).toBe(false);
    }
  });

  it('honors DSH_HOME via dshAgentPresetsRoot', async () => {
    process.env.DSH_HOME = dshHome;
    try {
      const mod = await loadModule();
      expect(mod.dshAgentPresetsRoot()).toBe(path.join(dshHome, '.agent-presets'));
    } finally {
      delete process.env.DSH_HOME;
    }
  });

  it('defaults to ~/.dsh when DSH_HOME is unset', async () => {
    const saved = process.env.DSH_HOME;
    delete process.env.DSH_HOME;
    try {
      const mod = await loadModule();
      const root = mod.dshAgentPresetsRoot();
      expect(root.endsWith(path.join('.dsh', '.agent-presets'))).toBe(true);
      expect(root.startsWith(path.resolve(path.join(process.env.HOME || process.env.USERPROFILE || '')))).toBe(true);
    } finally {
      if (saved !== undefined) process.env.DSH_HOME = saved;
    }
  });

  it('dry-run reports counts without writing anything', async () => {
    const mod = await loadModule();
    const destRoot = path.join(dshHome, '.agent-presets');
    const n = mod.deployAgentPresets({ dryRun: true, quiet: true, presetSourceDir: sourceDir, presetDestRoot: destRoot });
    expect(n).toBe(2);
    expect(existsSync(destRoot)).toBe(false);
  });

  it('restores drifted deployed copies (corpus wins on redeploy)', async () => {
    const mod = await loadModule();
    const destRoot = path.join(dshHome, '.agent-presets');
    mod.deployAgentPresets({ quiet: true, presetSourceDir: sourceDir, presetDestRoot: destRoot });
    const deployed = path.join(destRoot, 'aiwg-coding-worker', 'agent.cordis.yml');
    writeFileSync(deployed, 'drifted');
    mod.deployAgentPresets({ quiet: true, presetSourceDir: sourceDir, presetDestRoot: destRoot });
    expect(readFileSync(deployed, 'utf8')).toContain('aiwg-coding-worker');
    expect(readFileSync(deployed, 'utf8')).not.toBe('drifted');
  });

  it('skips preset directories lacking both contract files', async () => {
    mkdirSync(path.join(sourceDir, 'broken-preset'), { recursive: true });
    writeFileSync(path.join(sourceDir, 'broken-preset', 'notes.txt'), 'no contract files\n');
    const mod = await loadModule();
    const destRoot = path.join(dshHome, '.agent-presets');
    const n = mod.deployAgentPresets({ quiet: true, presetSourceDir: sourceDir, presetDestRoot: destRoot });
    expect(n).toBe(2);
    expect(existsSync(path.join(destRoot, 'broken-preset'))).toBe(false);
  });

  it('returns 0 for a missing source dir instead of throwing', async () => {
    const mod = await loadModule();
    const n = mod.deployAgentPresets({ quiet: true, presetSourceDir: path.join(tmp, 'does-not-exist'), presetDestRoot: path.join(dshHome, '.agent-presets') });
    expect(n).toBe(0);
  });

  it('is repeatable within a process (the once-per-run guard lives in deploy(), which shells out per invocation)', async () => {
    const mod = await loadModule();
    const destRoot = path.join(dshHome, '.agent-presets');
    const first = mod.deployAgentPresets({ quiet: true, presetSourceDir: sourceDir, presetDestRoot: destRoot });
    const second = mod.deployAgentPresets({ quiet: true, presetSourceDir: sourceDir, presetDestRoot: destRoot });
    expect(first).toBe(2);
    expect(second).toBe(2);
  });

  it('corpus ships the three aiwg worker presets with both contract files', async () => {
    for (const id of ['aiwg-efficiency-worker', 'aiwg-coding-worker', 'aiwg-reasoning-worker']) {
      expect(existsSync(path.join(CORPUS_PRESETS, id, 'agent.cordis.yml'))).toBe(true);
      expect(existsSync(path.join(CORPUS_PRESETS, id, 'preset.yml'))).toBe(true);
      const text = readFileSync(path.join(CORPUS_PRESETS, id, 'agent.cordis.yml'), 'utf8');
      expect(text).toContain('aiwg discover');
      expect(text).toContain('aiwg show');
    }
  });
});
