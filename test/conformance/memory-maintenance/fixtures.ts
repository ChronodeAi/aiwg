import fs from 'node:fs';
import path from 'node:path';
import { discoverProjectLocalBundles } from '../../../src/extensions/project-local-discovery.js';
import { PROVIDER_IDS } from '../../../src/providers/provider-definitions.js';
import { listProviderMemoryAdapters, PROVIDER_MEMORY_ADAPTERS, type ProviderMemoryAdapter } from '../../../src/memory/provider-memory-adapter.js';
import type { MaintenanceOwner } from '../../../src/memory/maintenance-owner.js';
import type { MaintenanceOp, MaintenanceOperation, MaintenancePlan } from '../../../src/memory/maintenance-contract.js';
import { buildIndex, parseFrontmatter } from '../../../src/artifacts/index-builder.js';
import { queryIndex } from '../../../src/artifacts/query-engine.js';
import { estimateTokens, TOKEN_ESTIMATOR_2936 } from '../../../src/memory/cost.js';
import config from '../../fixtures/memory-maintenance/qualification.json';
import heldOut from '../../fixtures/memory-maintenance/qualification-tasks.json';

export { config };
export const at = '2026-10-24T12:00:00.000Z';
export const sourcePath = (id: string) => `.aiwg/wiki/${id}.md`;
export function write(root: string, file: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), body);
}
export function snapshot(root: string): unknown {
  return fs.readdirSync(root).sort().map(name => {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    return [name, stat.mode, stat.mtimeMs, stat.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('base64')];
  });
}

export function seedLocalProviders(root: string): void {
  for (const provider of config.localProviders) write(root, `.aiwg/providers/${provider.id}/manifest.json`, JSON.stringify({
    id: provider.id, type: 'provider', name: provider.id, description: 'Synthetic derived provider',
    manifestVersion: '1', version: '1.0.0', platforms: { [provider.extends]: 'full' },
    keywords: ['qualification'], deployment: { pathTemplate: '.{platform}/skills/{id}.md' },
    providerConfig: { extends: provider.extends },
  }));
}
export interface RosterRow { id: string; adapter: ProviderMemoryAdapter; disposition: 'canonical' | 'inherited-common-fallback' }
/** Test roster uses the deployed manifest loader, never a second provider/path table. */
export async function roster(root: string, registry = PROVIDER_MEMORY_ADAPTERS): Promise<RosterRow[]> {
  const canonical = listProviderMemoryAdapters(registry);
  if (canonical.length !== PROVIDER_IDS.length) throw new Error('Incomplete provider roster');
  const discovered = await discoverProjectLocalBundles(root);
  if (discovered.errors.length) throw new Error(JSON.stringify(discovered.errors));
  const rows: RosterRow[] = canonical.map(adapter => ({ id: adapter.providerId, adapter, disposition: 'canonical' }));
  for (const bundle of discovered.bundles.filter(bundle => bundle.type === 'provider')) {
    const base = bundle.manifest.providerConfig?.extends;
    const adapter = canonical.find(adapter => adapter.providerId === base);
    if (!adapter || rows.some(row => row.id === bundle.id)) throw new Error(`Missing or colliding memory-adapter disposition: ${bundle.id}`);
    rows.push({ id: bundle.id, adapter, disposition: 'inherited-common-fallback' });
  }
  return rows;
}

export async function rebuild(root: string): Promise<void> {
  for (const graph of [undefined, 'project'] as const) await buildIndex(root, { graph, force: true, quiet: true, workers: 0 });
}
export function body(root: string, id: string): string {
  return parseFrontmatter(fs.readFileSync(path.join(root, sourcePath(id)), 'utf8')).body;
}
export function seedCorpus(root: string): void {
  for (const fact of config.facts) write(root, sourcePath(fact.id),
    `---\ntype: skill\nname: ${fact.id}\ndescription: ${fact.topic}\npinned: ${'pinned' in fact && fact.pinned === true}\n---\n${fact.topic} fact ${fact.key}=${fact.value}\n`);
  for (const rule of config.rules) write(root, sourcePath(rule.id),
    `---\ntype: rule\nname: ${rule.id}\ndescription: ${rule.topic}\n---\n${rule.topic} obligation action=${rule.action}\n`);
  for (const distractor of config.distractors) write(root, sourcePath(distractor.id),
    `---\ntype: skill\nname: ${distractor.id}\ndescription: ${distractor.topic}\n---\n${distractor.topic} background: ancillary historical context with no operational instruction or task answer.\n`);
}

export async function plan(owner: MaintenanceOwner, op: MaintenanceOp, id: string, changes: Partial<MaintenanceOperation> = {}): Promise<MaintenancePlan> {
  const record = (await owner.records()).find(record => record.sourcePath === sourcePath(id));
  if (!record) throw new Error(`Missing fixture target ${id}`);
  return { schemaVersion: 'aiwg.maintenance-plan.v1', operations: [{
    op, target: { id: record.id, digest: record.digest, version: record.version },
    precondition: { digest: record.digest, version: record.version },
    owner: { name: owner.name, handle: record.sourcePath, snapshot: await owner.snapshot() },
    review: { reviewer: 'synthetic operator', retirementBasis: 'review' },
    from: { placement: record.placement, lifecycle: record.lifecycle },
    to: { placement: record.placement, lifecycle: op === 'retire' ? 'retired' : op === 'restore' ? 'active'
      : ['merge', 'split', 'supersede'].includes(op) ? 'superseded' : record.lifecycle },
    scope: record.scope, rationale: 'Reviewed fixture operation', uncertainty: 'Fixture only; no native session evidence',
    impactedLinks: [record.sourcePath], sessionEffect: 'next-session', ...changes,
  }] };
}

/** Capture the actual public local query JSON, including its tool-response cost. */
async function query(root: string, text: string, output: { mock: { calls: unknown[][] }; mockClear(): unknown }) {
  output.mockClear();
  await queryIndex(root, { text, graph: 'project', limit: 20 }, { backend: 'local', json: true });
  const payload = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
  // Runtime timing metadata is excluded from fixture cost variability. Latency
  // is simulated separately; this never presents elapsed time as a fixture metric.
  payload.query_time_ms = 0;
  return { paths: payload.results.map((entry: { path: string }) => entry.path) as string[], serializedResponse: JSON.stringify(payload, null, 2) };
}
export async function retrieve(root: string, text: string, output: Parameters<typeof query>[2]): Promise<string[]> {
  return (await query(root, text, output)).paths;
}

export type Baseline = 'unchanged' | 'no-memory' | 'indexed' | 'selected-context' | 'resident';
export const baselines: Baseline[] = ['unchanged', 'no-memory', 'indexed', 'selected-context', 'resident'];
export interface Metrics {
  recall: number; staleHits: number; activation: number; adherence: number; completion: number;
  totalContextTokens: number; simulatedLatencyMs: number;
  sourceSurvival: number; migrationRecall: number;
}
const tokens = (value: string) => estimateTokens(Buffer.byteLength(value))!;

/** Fixed policy interpreter: first matching fact and first topic obligation win.
 * It sees only context text and the request, never the held-out expected values.
 * These are fixture outcome proxies, not model behavior measurements. */
export function interpret(context: string[], request: { key: string; query: string }) {
  const fact = context.join('\n').match(new RegExp(`\\bfact ${request.key}=([^\\s]+)`))?.[1] ?? null;
  const action = context.join('\n').match(new RegExp(`${request.query} obligation action=([^\\s]+)`))?.[1] ?? 'no-obligation';
  return { fact, action };
}

export async function compareBaselines(root: string, output: Parameters<typeof retrieve>[2], migrationRecall: number, sourceSurvival: number) {
  const allPaths = [...config.facts, ...config.rules, ...config.distractors].map(item => sourcePath(item.id));
  const activePaths = allPaths.filter(file => {
    const data = parseFrontmatter(fs.readFileSync(path.join(root, file), 'utf8')).data;
    const record = data.memoryRecord as { lifecycle: string; placement: string } | undefined;
    return !record || (record.lifecycle === 'active' && record.placement !== 'archived');
  });
  const rows = [];
  for (const baseline of baselines) {
    let recalled = 0, staleHits = 0, activated = 0, adhered = 0, completed = 0;
    let totalContextTokens = 0, simulatedLatencyMs = 0;
    const costLayers = { startup: 0, tool: 0, request: 0, selectedContext: 0, response: 0 };
    const tasks = [];
    for (const task of heldOut.tasks) {
      const queried = baseline === 'indexed' || baseline === 'selected-context' ? await query(root, task.query, output) : { paths: [], serializedResponse: '' };
      const queryPaths = queried.paths;
      // Fixed fixture grammar selects operational context, then rank/budget.
      // No held-out expected IDs, values or actions enter selection.
      const selected = queryPaths.filter(file => /\bfact \w+=|\bobligation action=/.test(
        parseFrontmatter(fs.readFileSync(path.join(root, file), 'utf8')).body,
      )).slice(0, 2);
      const paths = baseline === 'unchanged' ? allPaths : baseline === 'resident' ? activePaths
        : baseline === 'indexed' ? queryPaths : baseline === 'selected-context' ? selected : [];
      const context = paths.map(file => parseFrontmatter(fs.readFileSync(path.join(root, file), 'utf8')).body);
      const response = interpret(context, task);
      const hits = task.requiredFacts.filter(id => paths.includes(sourcePath(id))).length;
      const stale = config.facts.filter(fact => fact.stale && paths.includes(sourcePath(fact.id))).length;
      const activation = paths.includes(sourcePath(task.rule));
      const adherence = response.action === task.expectedAction;
      const completion = response.fact === task.expectedValue && adherence;
      recalled += hits / task.requiredFacts.length; staleHits += stale;
      activated += Number(activation); adhered += Number(adherence); completed += Number(completion);
      const resident = baseline === 'resident' || baseline === 'unchanged';
      const lookup = baseline === 'indexed' || baseline === 'selected-context';
      const startup = resident ? context.reduce((sum, text) => sum + tokens(text), 0) : lookup ? tokens(config.discoveryAnchor) : 0;
      const selectedContext = resident ? 0 : context.reduce((sum, text) => sum + tokens(text), 0);
      const tool = lookup ? tokens(config.toolSchema) + tokens(task.query) + tokens(queried.serializedResponse) : 0;
      const request = tokens(`${task.query}: ${task.key}`), responseTokens = tokens(JSON.stringify(response));
      costLayers.startup += startup; costLayers.selectedContext += selectedContext; costLayers.tool += tool;
      costLayers.request += request; costLayers.response += responseTokens;
      totalContextTokens += startup + selectedContext + tool + request + responseTokens;
      simulatedLatencyMs += config.latency.taskMs + (lookup ? config.latency.queryMs + queryPaths.length * config.latency.perResultMs : 0)
        + (startup + selectedContext + tool + request + responseTokens) * config.latency.perContextTokenMs;
      tasks.push({ id: task.id, retrieved: paths, response, recall: hits / task.requiredFacts.length, staleHits: stale, activation, adherence, completion });
    }
    const n = heldOut.tasks.length;
    const metrics: Metrics = { recall: recalled / n, staleHits, activation: activated / n, adherence: adhered / n, completion: completed / n,
      totalContextTokens, simulatedLatencyMs: Number(simulatedLatencyMs.toFixed(4)), sourceSurvival, migrationRecall };
    rows.push({ baseline, metrics, costLayers, tasks, estimator: TOKEN_ESTIMATOR_2936, kind: 'synthetic fixture metrics; simulated local retrieval and policy interpreter' });
  }
  return rows;
}

/** Quality floors are mandatory even when edits succeed or costs approach zero. */
export function gate(metrics: Metrics, thresholds = config.thresholds): string[] {
  const failures: string[] = [];
  for (const [metric, floor] of [
    ['recall', thresholds.minimumRecall], ['activation', thresholds.minimumActivation], ['adherence', thresholds.minimumAdherence],
    ['completion', thresholds.minimumCompletion], ['sourceSurvival', thresholds.minimumSourceSurvival], ['migrationRecall', thresholds.minimumMigrationRecall],
  ] as const) if (!Number.isFinite(metrics[metric]) || metrics[metric] < floor) failures.push(metric);
  for (const [metric, ceiling] of [
    ['staleHits', thresholds.maximumStaleHits], ['totalContextTokens', thresholds.maximumContextTokens], ['simulatedLatencyMs', thresholds.maximumSimulatedLatencyMs],
  ] as const) if (!Number.isFinite(metrics[metric]) || metrics[metric] > ceiling) failures.push(metric);
  return failures;
}
