// Verify incremental build work and payload stability independently of wall-clock timing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { INDEX_DIR } from '../../../src/artifacts/types.js';

const ARTIFACT_COUNT = 3000;
const options = { graph: 'codebase', quiet: true };

function snapshotPayloads(indexDir: string) {
  // Build telemetry intentionally updates on every successful verification.
  return Object.fromEntries(fs.readdirSync(indexDir).sort()
    .filter(name => name !== 'stats.json' && name !== 'freshness.json')
    .map(name => {
      const file = path.join(indexDir, name);
      return [name, {
        digest: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        mtimeNs: fs.statSync(file, { bigint: true }).mtimeNs,
      }];
    }));
}

describe('index-builder no-op work', () => {
  let tmpDir: string;
  let indexDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-index-noop-'));
    indexDir = path.join(tmpDir, INDEX_DIR, 'codebase');
    const sourceDir = path.join(tmpDir, 'src');
    fs.mkdirSync(sourceDir, { recursive: true });
    for (let i = 0; i < ARTIFACT_COUNT; i++) {
      const refs = [1, 2, 3]
        .map(offset => `@src/artifact-${(i + offset) % ARTIFACT_COUNT}.ts`).join('\n');
      fs.writeFileSync(path.join(sourceDir, `artifact-${i}.ts`),
        `---\ntitle: Artifact ${i}\ntags: [synthetic]\n---\n# Artifact ${i}\n\n${refs}\n`);
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('re-parses zero of 3000 unchanged artifacts and preserves index payloads', async () => {
    const forcedStart = performance.now();
    const forced = await buildIndex(tmpDir, { ...options, force: true });
    const forcedMs = performance.now() - forcedStart;
    expect(forced).toMatchObject({ checked: ARTIFACT_COUNT, reindexed: ARTIFACT_COUNT });
    const before = snapshotPayloads(indexDir);
    expect(Object.keys(before)).toEqual([
      'checksum-manifest.json', 'dependencies.json', 'metadata.json', 'tags.json',
    ]);

    const incrementalStart = performance.now();
    const incremental = await buildIndex(tmpDir, options);
    const incrementalMs = performance.now() - incrementalStart;
    console.info(`3000 artifacts: forced=${forcedMs.toFixed(1)}ms, no-op=${incrementalMs.toFixed(1)}ms (${(100 * incrementalMs / forcedMs).toFixed(1)}%)`);

    expect(incremental).toMatchObject({
      checked: ARTIFACT_COUNT, statSkipped: ARTIFACT_COUNT, checksumSkipped: 0, reindexed: 0,
    });
    expect(snapshotPayloads(indexDir)).toEqual(before);
    const stats = JSON.parse(fs.readFileSync(path.join(indexDir, 'stats.json'), 'utf8'));
    expect(stats.totalArtifacts).toBe(ARTIFACT_COUNT);
    expect(stats.graphMetrics.totalEdges).toBe(ARTIFACT_COUNT * 3);
  });

  it('reports exactly one re-parse when one of 3000 artifacts changes', async () => {
    await buildIndex(tmpDir, { ...options, force: true });
    const source = path.join(tmpDir, 'src', 'artifact-0.ts');
    const original = fs.readFileSync(source, 'utf8');
    try {
      // Change content as well as size: an mtime-only touch just verifies the checksum.
      fs.appendFileSync(source, '\nChanged artifact content.\n');
      const changed = await buildIndex(tmpDir, options);
      expect(changed).toMatchObject({
        checked: ARTIFACT_COUNT, statSkipped: ARTIFACT_COUNT - 1, checksumSkipped: 0, reindexed: 1,
      });
      const metadata = JSON.parse(fs.readFileSync(path.join(indexDir, 'metadata.json'), 'utf8'));
      expect(metadata.entries['src/artifact-0.ts'].checksum)
        .toBe(createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 16));
      const before = snapshotPayloads(indexDir);
      expect(await buildIndex(tmpDir, options)).toMatchObject({ reindexed: 0 });
      expect(snapshotPayloads(indexDir)).toEqual(before);
    } finally {
      fs.writeFileSync(source, original);
    }
  });
});
