import { writeSync } from 'node:fs';
import { CodexSessionAdapter } from '../../../src/sessions/adapters/codex.js';
import { IncrementalSessionImporter } from '../../../src/sessions/importer.js';
import { SESSION_CONTRACT_VERSION, type SelectedSource, type SessionSource } from '../../../src/sessions/contracts.js';
import type { SessionRepositoryPort } from '../../../src/sessions/ports.js';

const [path, root] = process.argv.slice(2);
if (!path || !root) throw new Error('import memory probe requires source path and root');

const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
if (!forceGc) throw new Error('import memory probe requires --expose-gc');

forceGc();
const baseline = process.memoryUsage();
const baselineMaxRss = process.resourceUsage().maxRSS * 1024;
let peakHeap = baseline.heapUsed;
let peakRss = baseline.rss;
const sample = (): void => {
  const memory = process.memoryUsage();
  peakHeap = Math.max(peakHeap, memory.heapUsed);
  peakRss = Math.max(peakRss, memory.rss);
};
const sampler = setInterval(sample, 10);
let eventsImported = 0;
let recordsRead = 0;
let sourceSize = 0;

// Discard committed events so the probe measures import working memory.
const repository: SessionRepositoryPort = {
  getCheckpoint: () => null,
  getBatchCheckpoint: () => null,
  commitStagedImports: () => 0,
  applyImport(batch, checkpoint) {
    sample();
    eventsImported += batch.events.length;
    recordsRead = checkpoint.recordsRead;
    sourceSize = checkpoint.sourceSize ?? 0;
    return {
      operationId: batch.run.importRunId,
      outcome: 'committed',
      sessionsInserted: batch.sessions.length,
      eventsInserted: batch.events.length,
      checkpoint: { ...checkpoint },
    };
  },
};

try {
  const selectedSource: SelectedSource = {
    sourceId: 'synthetic-large-source',
    provider: 'codex',
    locator: path,
    locatorClass: 'codex-rollout-jsonl',
    authorizedScope: { workspaceId: 'synthetic-workspace', allowedRoots: [root] },
  };
  const adapter = new CodexSessionAdapter();
  const probe = await adapter.inspect(selectedSource);
  sample();
  const source: SessionSource = {
    contractVersion: SESSION_CONTRACT_VERSION,
    sourceId: selectedSource.sourceId,
    provider: 'codex',
    providerProfile: 'rollout',
    locatorClass: selectedSource.locatorClass,
    redactedLocator: '<session-source>/rollout.jsonl',
    adapterVersion: adapter.adapterVersion,
    sourceSchemaVersion: probe.sourceSchemaVersion,
    disposition: 'implemented',
    operationalState: probe.operationalState,
    consistency: probe.consistency,
    authorizedAt: '2026-10-18T00:00:00.000Z',
    extensions: {},
  };
  await new IncrementalSessionImporter(repository).import({
    source,
    selectedSource,
    adapter,
    workspaceId: 'synthetic-workspace',
    policyVersion: '1.0.0',
  });
  sample();
  writeSync(1, JSON.stringify({
    eventsImported,
    recordsRead,
    sourceSize,
    peakRssGrowthBytes: Math.max(0,
      peakRss - baseline.rss,
      process.resourceUsage().maxRSS * 1024 - baselineMaxRss,
    ),
    peakHeapGrowthBytes: Math.max(0, peakHeap - baseline.heapUsed),
  }));
} finally {
  clearInterval(sampler);
}
