/**
 * Tier 1: Full Index Build (smoke test)
 *
 * Runs buildIndex() against an isolated corpus and validates structural
 * correctness of the output.
 *
 * @integration
 * @slow
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { ArtifactIndex, TagIndex, DependencyGraph, IndexStats } from '../../../src/artifacts/types.js';
import {
  buildFixtureIndex,
  FIXTURE_ENTRY_PATHS,
  type BuiltFixtureIndex,
} from './fixture-corpus.js';
const INDEX_BUILD_BUDGET_MS = parseIntEnv('AIWG_INDEX_BUILD_BUDGET_MS', 15_000);

function parseIntEnv(name: string, def: number): number {
  const raw = process.env[name];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : def;
}

describe('Artifact Index Build (integration)', () => {
  let fixture: BuiltFixtureIndex;
  let metadata: ArtifactIndex;
  let tags: TagIndex;
  let deps: DependencyGraph;
  let stats: IndexStats;

  beforeAll(async () => {
    fixture = await buildFixtureIndex();
    metadata = fixture.metadata;
    tags = fixture.tags;
    deps = fixture.dependencies;
    stats = fixture.stats;
  }, 30_000);

  afterAll(() => {
    fixture?.cleanup();
  });

  it('should produce all 4 output files', () => {
    const indexDir = fixture.indexDir;
    for (const file of ['metadata.json', 'tags.json', 'dependencies.json', 'stats.json']) {
      expect(fs.existsSync(path.join(indexDir, file)), `${file} should exist`).toBe(true);
    }
  });

  it('should index exactly the explicit fixture artifacts', () => {
    expect(Object.keys(metadata.entries).sort()).toEqual(FIXTURE_ENTRY_PATHS);
  });

  it('should have required fields on every entry', () => {
    for (const [entryPath, entry] of Object.entries(metadata.entries)) {
      expect(entry.path, `path on ${entryPath}`).toBe(entryPath);
      expect(entry.type, `type on ${entryPath}`).toBeTruthy();
      expect(entry.phase, `phase on ${entryPath}`).toBeTruthy();
      expect(entry.title, `title on ${entryPath}`).toBeTruthy();
      expect(entry.checksum, `checksum on ${entryPath}`).toMatch(/^[a-f0-9]{16}$/);
      expect(entry.created, `created on ${entryPath}`).toBeTruthy();
      expect(entry.updated, `updated on ${entryPath}`).toBeTruthy();
    }
  });

  it('should cover at least 5 SDLC phases', () => {
    const phaseCount = Object.keys(stats.byPhase).length;
    expect(phaseCount).toBeGreaterThanOrEqual(5);
  });

  it('should have valid index version and timing', () => {
    expect(metadata.version).toBe('1.0.0');
    expect(metadata.builtAt).toBeTruthy();
    expect(metadata.buildTimeMs).toBeGreaterThan(0);
  });

  it(`should build within performance budget (< ${INDEX_BUILD_BUDGET_MS / 1000}s)`, () => {
    if (!metadata) return;
    // The package now ships prebuilt Fortemi indexes that users previously
    // built locally, so the real-corpus smoke budget accounts for that larger
    // indexed artifact set while still catching material regressions.
    expect(metadata.buildTimeMs).toBeLessThan(INDEX_BUILD_BUDGET_MS);
  });

  it('should produce consistent stats', () => {
    expect(stats.totalArtifacts).toBe(Object.keys(metadata.entries).length);
    // Sum of byPhase values should equal totalArtifacts
    const phaseSum = Object.values(stats.byPhase).reduce((a, b) => a + b, 0);
    expect(phaseSum).toBe(stats.totalArtifacts);
    // Sum of byType values should equal totalArtifacts
    const typeSum = Object.values(stats.byType).reduce((a, b) => a + b, 0);
    expect(typeSum).toBe(stats.totalArtifacts);
  });

  it('should produce a non-empty dependency graph', () => {
    const graphEntries = Object.keys(deps).length;
    expect(graphEntries).toBeGreaterThan(0);
    // At least some artifacts should have cross-references
    const withUpstream = Object.values(deps).filter(n => n.upstream.length > 0).length;
    expect(withUpstream).toBeGreaterThan(0);
  });

  it('builds the same corpus through a relocated artifact root', async () => {
    const relocated = await buildFixtureIndex(true);
    try {
      expect(Object.keys(relocated.metadata.entries).sort()).toEqual(FIXTURE_ENTRY_PATHS);
      expect(Object.keys(relocated.stats.byPhase).length).toBeGreaterThanOrEqual(5);
    } finally {
      relocated.cleanup();
    }
  });
});

// A separate parent process proves that a fatal preparation heap exhaustion is
// contained, rather than merely exercising a mocked worker error event.
describe('index preparation heap isolation (integration)', () => {
  it('survives a real worker heap fatal, retries serially and exits zero with a JSON report', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-index-oom-'));
    try {
      const artifact = path.join(root, 'amplifying.json');
      fs.writeFileSync(artifact, JSON.stringify({ slots: 48 * 1024 ** 2 }));
      const module = path.join(root, 'extractor.mjs');
      fs.writeFileSync(module, `
        import fs from 'node:fs';
        export function prepareIndexArtifact(job) {
          const data = JSON.parse(fs.readFileSync(job.fullPath, 'utf8'));
          // A tiny input with an unexpectedly large preparation working set.
          const expanded = new Array(data.slots).fill(7);
          return { checksum: String(expanded.length + expanded[expanded.length - 1]) };
        }
      `);
      fs.writeFileSync(path.join(root, 'small.json'), JSON.stringify({ slots: 1 }));
      const preparation = new URL('../../../src/artifacts/index-preparation.ts', import.meta.url).href;
      const report = execFileSync(process.execPath, ['--import', 'tsx', '--max-old-space-size=768', '--input-type=module', '-e', `
        import os from 'node:os';
        // Deterministic admission for this deliberately memory-bound fixture.
        os.availableParallelism = () => 4;
        os.freemem = process.availableMemory = () => 4 * 1024 ** 3;
        import { runIndexPreparation } from ${JSON.stringify(preparation)};
        import { prepareIndexArtifact } from ${JSON.stringify(pathToFileURL(module).href)};
        const jobs = Array.from({length: 64}, (_, i) => ({
          fullPath: ${JSON.stringify(artifact)}, relativePath: 'artifact-' + i,
          mtimeMs: 0, birthtimeMs: 0, sizeBytes: 32,
        }));
        // Only one artifact requires the large working set; later results stay cheap.
        const small = ${JSON.stringify(path.join(root, 'small.json'))};
        for (const job of jobs.slice(1)) job.fullPath = small;
        const result = await runIndexPreparation(jobs, prepareIndexArtifact, ${JSON.stringify(pathToFileURL(module).href)}, 2);
        console.log(JSON.stringify({status:'ok', count:result.results.length, first:result.results[0], diagnostics:result.diagnostics, workers:result.workerCount}));
      `], { cwd: path.resolve(import.meta.dirname, '../../..'), encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, HOME: root, XDG_DATA_HOME: root, XDG_STATE_HOME: root,
          XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, AIWG_INDEX_WORKERS: '' } });
      const parsed = JSON.parse(report);
      expect(parsed).toMatchObject({ status:'ok', count:64, first:{checksum:String(48 * 1024 ** 2 + 7)}, workers:2 });
      expect(parsed.diagnostics.join(' ')).toMatch(/heap out of memory.*serial/);
    } finally { fs.rmSync(root, { recursive:true, force:true }); }
  }, 60_000);
});
