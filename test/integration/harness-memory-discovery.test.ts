import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../../src/artifacts/index-builder.js';
import { discoverCapability, showArtifact } from '../../src/artifacts/query-engine.js';
import { syncFortemiCoreIndex } from '../../src/artifacts/fortemi-core-sync.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const SKILL = 'harness-memory-maintenance';
const RELATIVE_SKILL = `agentic/code/addons/aiwg-utils/skills/${SKILL}/SKILL.md`;
let temporaryRoot: string;

beforeEach(() => {
  temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'aiwg-harness-memory-discovery-'));
  vi.stubEnv('HOME', path.join(temporaryRoot, 'home'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(temporaryRoot, 'config'));
  vi.stubEnv('XDG_DATA_HOME', path.join(temporaryRoot, 'data'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(temporaryRoot, 'cache'));
  vi.stubEnv('AIWG_CONFIG', path.join(temporaryRoot, 'config', 'aiwg'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(temporaryRoot, { recursive: true, force: true });
});

async function captureJson(action: () => Promise<unknown>) {
  const captured: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => captured.push(args.map(String).join(' ')));
  try {
    await action();
    return JSON.parse(captured.join(''));
  } finally {
    log.mockRestore();
  }
}

describe('harness memory progressive discovery', () => {
  it('ranks the maintenance skill first and fetches each operation independently from the packaged corpus', async () => {
    const corpusRoot = path.join(temporaryRoot, 'corpus');
    mkdirSync(corpusRoot);
    cpSync(path.join(REPO_ROOT, 'agentic'), path.join(corpusRoot, 'agentic'), { recursive: true });
    vi.stubEnv('AIWG_ROOT', corpusRoot);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await buildIndex(corpusRoot, { graph: 'framework', force: true, explicit: true });
      syncFortemiCoreIndex(corpusRoot, {
        graph: 'framework', repo: 'aiwg-harness-memory-test', privacy: 'private',
        generatedAt: '2026-10-24T00:00:00.000Z',
      });
    } finally {
      log.mockRestore();
    }

    for (const operation of ['audit', 'cleanup', 'recategorize', 'promote', 'demote', 'retire']) {
      for (const backend of ['local', 'fortemi-core'] as const) {
        const result = await captureJson(() => discoverCapability(corpusRoot, {
          phrase: `harness memory ${operation}`, graph: 'framework', backend, json: true, limit: 5,
        }));
        expect(result.results[0]?.name, `${operation}/${backend}`).toBe(SKILL);
        expect(result.results[0]?.path).toContain(RELATIVE_SKILL);
      }
    }

    const show = (sections?: string[]) => captureJson(() => showArtifact(corpusRoot, {
      name: SKILL, typeFilter: ['skill'], graph: 'framework', backend: 'local', json: true, sections,
    }));
    const card = await show();
    expect(card.kernel).toBe(false);
    expect(card.content).toBeUndefined();
    expect(card.capability).toEqual({ kind: 'addon', name: 'aiwg-utils' });

    const anchor = await show(['Discover']);
    expect(Buffer.byteLength(anchor.content)).toBeLessThanOrEqual(600);
    expect(anchor.content).toContain('aiwg show skill harness-memory-maintenance --section');
    expect(anchor.content).not.toContain('aiwg memory apply --plan');
    for (const section of ['Audit', 'Cleanup', 'Review and Apply', 'Recategorize', 'Promote', 'Demote', 'Retire', 'Verify', 'Restore']) {
      const selected = await show([section]);
      expect(selected.content).toMatch(new RegExp(`^## ${section}\\n`));
      expect(selected.content).not.toContain('## References');
    }
    const defaultBackendSection = await captureJson(() => showArtifact(corpusRoot, {
      name: SKILL, typeFilter: ['skill'], graph: 'framework', backend: 'fortemi-core', json: true, sections: ['Verify'],
    }));
    expect(defaultBackendSection.content).toContain('aiwg memory verify --plan');
    await expect(show(['Missing operation'])).rejects.toThrow('Unknown heading');
  }, 60_000);

  it('registers a portable non-kernel skill without a startup rule or kernel trigger', () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'agentic/code/addons/aiwg-utils/manifest.json'), 'utf8'));
    const source = readFileSync(path.join(REPO_ROOT, RELATIVE_SKILL), 'utf8');
    expect(manifest.skills.filter((name: string) => name === SKILL)).toEqual([SKILL]);
    expect(manifest.rules).not.toContain(SKILL);
    expect(source).toMatch(/^platforms: \[all\]$/m);
    expect(source).not.toMatch(/^kernel:\s*true$/m);
    expect(source).not.toContain('aiwg harness memory');
    const description = source.match(/^description: (.+)$/m)![1];
    expect(description.length).toBeLessThanOrEqual(180);
  });
});
