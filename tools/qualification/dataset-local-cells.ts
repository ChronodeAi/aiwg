import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createBuiltinAdapterRegistry, FileAdapter, HttpAdapter, JsonlAdapter } from '../../src/dataset/adapters.js'
import { request } from '../../src/dataset/adapter-sdk.js'
import { computeProcessingPlanDigest } from '../../src/dataset/contracts.js'
import { LocalDatasetExecutionBackend } from '../../src/dataset/local-execution-backend.js'
import { MemoryDatasetOrchestrationRepository } from '../../src/dataset/orchestration-repository.js'
import { DatasetOrchestrationService } from '../../src/dataset/orchestration-service.js'
import { DATASET_CONTRACT_VERSION, type CapabilityProfile, type ProcessingPlan } from '../../src/dataset/types.js'
import { exportStandard, importStandard } from '../../src/dataset/standards.js'

const ROOT = process.cwd()
const SOURCE = resolve(ROOT, 'test/fixtures/dataset-intelligence/v1/sources/records.jsonl')
const REPLAY_CORPUS = resolve(ROOT, 'test/fixtures/dataset-intelligence/v1/incremental/replay.json')
const ADVERSARIAL_CORPUS = resolve(ROOT, 'test/fixtures/dataset-intelligence/v1/security/adversarial.json')

type ReplayItem = { id: string; cursor: number; tombstone?: boolean }
type ReplayCorpus = {
  initial: ReplayItem[]
  replay: ReplayItem[]
  duplicates: ReplayItem[]
  sameCursorTie: ReplayItem[]
  late: ReplayItem[]
  next: ReplayItem[]
  tombstones: ReplayItem[]
  schemaChange: { before: Record<string, unknown>; after: Record<string, unknown> }
  malformed: unknown[]
}
type AdversarialCorpus = {
  sentinel: string
  paths: [string, string]
  urls: [string, string]
  limits: { compressedBytes: number; expandedBytes: number; records: number; nesting: number }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

function isReplayItem(value: unknown): value is ReplayItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.id === 'string' && candidate.id.length > 0
    && Number.isInteger(candidate.cursor) && Number(candidate.cursor) >= 0
    && (candidate.tombstone === undefined || typeof candidate.tombstone === 'boolean')
}
const profile = (optional = false): CapabilityProfile => ({
  contractVersion: DATASET_CONTRACT_VERSION, kind: 'CapabilityProfile', id: `profile:conformance:${optional}`,
  capabilities: [
    { name: 'incremental-read', requirement: 'required', acceptedVersions: ['1'], degradation: { action: 'fail' } },
    ...(optional ? [{ name: 'index.vector', requirement: 'optional' as const, degradation: { action: 'disable' as const } }] : []),
  ],
})

async function planned(backend = new LocalDatasetExecutionBackend()) {
  const repo = new MemoryDatasetOrchestrationRepository()
  const service = new DatasetOrchestrationService(repo, { adapter: () => new JsonlAdapter(), localBackend: backend, now: () => '2026-09-03T00:00:00Z' })
  await service.source({ id: 'source:conformance', revisionId: 'revision:conformance', adapter: { id: 'aiwg.adapter.jsonl', version: '1.0.0' }, config: { path: SOURCE }, policy: { offline: true, allowedRoot: ROOT } })
  const result = await service.plan({ id: 'plan:conformance', sourceId: 'source:conformance', profile: profile(true), schemas: [{ id: 'schema:conformance', version: '1.0.0' }], policy: { privacy: 'internal', intendedUse: ['conformance'], locality: 'local-only', network: 'offline', authorizationRefs: [] }, steps: [{ id: 'step:materialize', operation: 'materialize', implementation: { id: 'local', version: '1' }, configDigest: { algorithm: 'sha256', value: 'a'.repeat(64) } }], artifactClasses: ['regenerable-index'], createdBy: 'conformance', estimates: { reads: 3, writes: 3 } })
  if (!result.ok) throw new Error(result.diagnostics[0]?.code ?? 'CONFORMANCE_PLAN_FAILED')
  return { repo, service, plan: result.data as ProcessingPlan }
}

export async function qualifyCapabilityBinding(): Promise<void> {
  const { service, plan } = await planned()
  if (!plan.capabilityDecision.degraded.some(item => item.capability === 'index.vector')) throw new Error('CONFORMANCE_OPTIONAL_DEGRADATION_UNBOUND')
  const mutated = { ...plan, estimates: { reads: 4, writes: 3 } }
  if (computeProcessingPlanDigest(mutated).value === plan.planDigest.value) throw new Error('CONFORMANCE_PLAN_DECISION_UNBOUND')
  const repo = new MemoryDatasetOrchestrationRepository()
  const strictService = new DatasetOrchestrationService(repo, { adapter: () => new JsonlAdapter(), localBackend: new LocalDatasetExecutionBackend() })
  await strictService.source({ id: 'source:strict', revisionId: 'r', adapter: { id: 'aiwg.adapter.jsonl', version: '1.0.0' }, config: { path: SOURCE }, policy: { offline: true, allowedRoot: ROOT } })
  const strict = await strictService.plan({ id: 'plan:strict', sourceId: 'source:strict', profile: { ...profile(), capabilities: [{ name: 'index.vector', requirement: 'required', degradation: { action: 'fail' } }] }, schemas: [], policy: { privacy: 'internal', intendedUse: ['conformance'], locality: 'local-only', network: 'offline', authorizationRefs: [] }, steps: [{ id: 's', operation: 'index', implementation: { id: 'local', version: '1' }, configDigest: { algorithm: 'sha256', value: 'b'.repeat(64) } }], artifactClasses: ['regenerable-index'], createdBy: 'conformance' })
  if (strict.ok || strict.diagnostics[0]?.code !== 'DATASET_REQUIRED_CAPABILITY_UNSUPPORTED') throw new Error('CONFORMANCE_REQUIRED_CAPABILITY_DID_NOT_FAIL_CLOSED')
}

export async function qualifyReplay(): Promise<void> {
  const corpus = await readJson<ReplayCorpus>(REPLAY_CORPUS)
  const requiredArrays = [corpus.initial, corpus.replay, corpus.duplicates, corpus.sameCursorTie, corpus.late, corpus.next, corpus.tombstones, corpus.malformed]
  if (requiredArrays.some(items => !Array.isArray(items) || items.length === 0)) throw new Error('CONFORMANCE_REPLAY_CORPUS_INCOMPLETE')
  if (JSON.stringify(corpus.initial) !== JSON.stringify(corpus.replay)) throw new Error('CONFORMANCE_REPLAY_CORPUS_NOT_EXACT')
  if (![...corpus.initial, ...corpus.replay, ...corpus.duplicates, ...corpus.sameCursorTie, ...corpus.late, ...corpus.next, ...corpus.tombstones].every(isReplayItem)) throw new Error('CONFORMANCE_REPLAY_CORPUS_RECORD_INVALID')
  if (corpus.malformed.some(isReplayItem)) throw new Error('CONFORMANCE_REPLAY_CORPUS_MALFORMED_CASE_ACCEPTED')
  if (new Set(corpus.duplicates.map(item => `${item.cursor}:${item.id}`)).size === corpus.duplicates.length) throw new Error('CONFORMANCE_REPLAY_CORPUS_DUPLICATE_MISSING')
  const tied = [...corpus.sameCursorTie].sort((left, right) => left.cursor - right.cursor || left.id.localeCompare(right.id))
  if (tied.some((item, index) => item.id !== corpus.sameCursorTie[index]?.id)) throw new Error('CONFORMANCE_REPLAY_CORPUS_TIE_UNORDERED')
  const initialCursor = Math.max(...corpus.initial.map(item => item.cursor))
  if (!corpus.late.some(item => item.cursor <= initialCursor) || !corpus.next.every(item => item.cursor > initialCursor)) throw new Error('CONFORMANCE_REPLAY_CORPUS_INCREMENTAL_BOUNDARY_MISSING')
  if (!corpus.tombstones.some(item => item.tombstone && item.cursor > initialCursor) || JSON.stringify(corpus.schemaChange.before) === JSON.stringify(corpus.schemaChange.after)) throw new Error('CONFORMANCE_REPLAY_CORPUS_BOUNDARY_MISSING')

  const { repo, service, plan } = await planned()
  const first = await service.ingest({ planId: plan.id, planDigest: plan.planDigest.value, idempotencyKey: 'conformance:once' })
  const replay = await service.ingest({ planId: plan.id, planDigest: plan.planDigest.value, idempotencyKey: 'conformance:once' })
  if (!first.ok || JSON.stringify(first.data) !== JSON.stringify(replay.data) || repo.runs.size !== 1) throw new Error('CONFORMANCE_EXACT_REPLAY_CHANGED_STATE')
  const other = { ...plan, id: 'plan:other' }; other.planDigest = computeProcessingPlanDigest(other); await repo.putPlan(other)
  const conflict = await service.ingest({ planId: other.id, planDigest: other.planDigest.value, idempotencyKey: 'conformance:once' })
  if (conflict.diagnostics[0]?.code !== 'DATASET_IDEMPOTENCY_CONFLICT') throw new Error('CONFORMANCE_IDEMPOTENCY_CONFLICT_NOT_REJECTED')
}

export async function qualifyCheckpointBoundaries(): Promise<void> {
  for (const outcome of ['failed', 'cancelled', 'ambiguous'] as const) {
    const backend = { id: 'local', capabilities: () => [{ name: 'incremental-read', version: '1' }], execute: async () => ({ outcome, attemptedRecords: 3, committedRecords: 0, rejectedRecords: 0, checkpoint: { forbidden: true }, diagnostics: [] }) }
    const { service, plan } = await planned(backend as never)
    const result = await service.ingest({ planId: plan.id, planDigest: plan.planDigest.value, idempotencyKey: `conformance:${outcome}` })
    if (!result.ok || (result.data as { checkpoint?: unknown }).checkpoint !== undefined) throw new Error(`CONFORMANCE_CHECKPOINT_ADVANCED_${outcome.toUpperCase()}`)
  }
  const { service, plan } = await planned()
  const committed = await service.ingest({ planId: plan.id, planDigest: plan.planDigest.value, idempotencyKey: 'conformance:commit' })
  if (!committed.ok || !(await service.verify((committed.data as { runId: string }).runId)).ok) throw new Error('CONFORMANCE_COMMIT_UNVERIFIED')
}

export async function qualifyProvenanceBinding(): Promise<void> {
  const { service, plan } = await planned()
  const ingested = await service.ingest({ planId: plan.id, planDigest: plan.planDigest.value, idempotencyKey: 'conformance:lineage' })
  if (!ingested.ok) throw new Error('CONFORMANCE_PROVENANCE_INGEST_FAILED')
  const lineage = await service.lineage((ingested.data as { runId: string }).runId)
  const value = lineage.data as { sourceRevisionId?: string; principal?: string; adapter?: { configDigest?: unknown }; schemas?: unknown[]; validation?: { valid?: boolean }; records?: unknown[] }
  if (!lineage.ok || value.sourceRevisionId !== 'revision:conformance' || value.principal !== 'conformance' || !value.adapter?.configDigest || !value.schemas?.length || value.validation?.valid !== true || value.records?.length !== 3) throw new Error('CONFORMANCE_PROVENANCE_BINDING_INCOMPLETE')
}

export async function qualifyOfflineMatrix(): Promise<void> {
  let attempts = 0
  const adapter = new HttpAdapter(async () => { attempts += 1; throw new Error('NETWORK_ATTEMPTED_OFFLINE') })
  for (const [state, code] of [['stale', 'DATASET_OFFLINE_STALE'], ['corrupt', 'DATASET_OFFLINE_CORRUPT'], ['wrong-revision', 'DATASET_OFFLINE_WRONG_REVISION'], ['unverifiable', 'DATASET_OFFLINE_UNVERIFIABLE']] as const) {
    const repo = new MemoryDatasetOrchestrationRepository(); const service = new DatasetOrchestrationService(repo, { adapter: () => adapter, localBackend: new LocalDatasetExecutionBackend() })
    await service.source({ id: state, revisionId: 'r1', adapter: { id: 'aiwg.adapter.http', version: '1.0.0' }, config: { url: 'https://allowed.example/data' }, policy: { offline: true }, cache: { state } })
    if ((await service.check(state, true)).diagnostics[0]?.code !== code) throw new Error(`CONFORMANCE_OFFLINE_${state.toUpperCase()}_COLLAPSED`)
  }
  const repo = new MemoryDatasetOrchestrationRepository(); const service = new DatasetOrchestrationService(repo, { adapter: () => adapter, localBackend: new LocalDatasetExecutionBackend() })
  await service.source({ id: 'warm', revisionId: 'r1', identity: 'cached:r1', adapter: { id: 'aiwg.adapter.http', version: '1.0.0' }, config: { url: 'https://allowed.example/data' }, policy: { offline: true }, cache: { state: 'warm-verified', records: [] } })
  if (!(await service.check('warm', true)).ok || attempts !== 0) throw new Error('CONFORMANCE_OFFLINE_NETWORK_ATTEMPTED')
}

export async function qualifyAdversarialAdapters(): Promise<void> {
  const corpus = await readJson<AdversarialCorpus>(ADVERSARIAL_CORPUS)
  if (!corpus.sentinel || corpus.paths.length !== 2 || corpus.urls.length !== 2 || corpus.limits.expandedBytes <= corpus.limits.compressedBytes) throw new Error('CONFORMANCE_ADVERSARIAL_CORPUS_INCOMPLETE')
  const temporary = await mkdtemp(resolve(tmpdir(), 'aiwg-dataset-adversarial-'))
  try {
    const secret = await new HttpAdapter().configure({ url: 'https://allowed.example/data', password: corpus.sentinel })
    if (secret.ok || secret.diagnostics[0]?.code !== 'ADAPTER_SECRET_REJECTED' || JSON.stringify(secret).includes(corpus.sentinel)) throw new Error('CONFORMANCE_SECRET_REJECTION_FAILED')

    const traversal = await new FileAdapter().check(request('traversal', { path: corpus.paths[0] }, { offline: true, allowedRoot: temporary }))
    if (traversal.diagnostics[0]?.code !== 'ADAPTER_PATH_ESCAPE') throw new Error('CONFORMANCE_TRAVERSAL_NOT_REJECTED')
    const linkedDirectory = resolve(temporary, 'link')
    await mkdir(linkedDirectory)
    const symlinkTarget = resolve(temporary, 'symlink-target.txt')
    await writeFile(symlinkTarget, 'synthetic target')
    await symlink(symlinkTarget, resolve(temporary, corpus.paths[1]))
    const linked = await new FileAdapter().check(request('symlink', { path: corpus.paths[1] }, { offline: true, allowedRoot: temporary }))
    if (linked.diagnostics[0]?.code !== 'ADAPTER_UNSAFE_SYMLINK') throw new Error('CONFORMANCE_SYMLINK_NOT_REJECTED')

    const oversizedPath = resolve(temporary, 'oversized.txt')
    await writeFile(oversizedPath, 'x'.repeat(corpus.limits.compressedBytes + 1))
    const oversized = await new FileAdapter().preview({ ...request('bytes', { path: 'oversized.txt' }, { offline: true, allowedRoot: temporary }, { maxBytes: corpus.limits.compressedBytes }), count: 1 })
    if (oversized.diagnostics[0]?.code !== 'ADAPTER_RESOURCE_LIMIT') throw new Error('CONFORMANCE_BYTE_LIMIT_NOT_ENFORCED')

    const repeatedPath = resolve(temporary, 'records.jsonl')
    await writeFile(repeatedPath, `${JSON.stringify({ id: 'a', declaredLimit: corpus.limits.records })}\n${JSON.stringify({ id: 'b', declaredLimit: corpus.limits.records })}\n`)
    let recordLimitCode: string | undefined
    for await (const event of new JsonlAdapter().read(request('records', { path: 'records.jsonl' }, { offline: true, allowedRoot: temporary }, { maxRecords: 1 }))) {
      if (event.kind === 'diagnostic') recordLimitCode = event.diagnostic.code
    }
    if (recordLimitCode !== 'ADAPTER_RESOURCE_LIMIT') throw new Error('CONFORMANCE_RECORD_LIMIT_NOT_ENFORCED')

    let nested: unknown = 'leaf'
    for (let depth = 0; depth < corpus.limits.nesting; depth += 1) nested = { nested }
    await writeFile(resolve(temporary, 'nested.jsonl'), `${JSON.stringify(nested)}\n`)
    let nestingCode: string | undefined
    for await (const event of new JsonlAdapter().read(request('nesting', { path: 'nested.jsonl' }, { offline: true, allowedRoot: temporary }, { maxDepth: corpus.limits.nesting - 1 }))) {
      if (event.kind === 'diagnostic') nestingCode = event.diagnostic.code
    }
    if (nestingCode !== 'ADAPTER_RESOURCE_LIMIT') throw new Error('CONFORMANCE_NESTING_LIMIT_NOT_ENFORCED')

    let protocolFetches = 0
    const protocol = new HttpAdapter(async () => { protocolFetches += 1; return new Response('{}') })
    const protocolResult = await protocol.check(request('protocol-downgrade', { url: corpus.urls[0] }, { offline: false, allowedHosts: ['127.0.0.1'] }))
    if (protocolResult.diagnostics[0]?.code !== 'ADAPTER_NETWORK_PROHIBITED' || protocolFetches !== 0) throw new Error('CONFORMANCE_PROTOCOL_DOWNGRADE_NOT_REJECTED')

    let ssrfFetches = 0
    const ssrf = new HttpAdapter(async () => { ssrfFetches += 1; return new Response('{}') }, async () => [{ address: '127.0.0.1' }])
    const configured = await ssrf.configure({ url: 'https://allowed.example/data' })
    const checked = await ssrf.check(request('ssrf', configured.config!, { offline: false, allowedHosts: ['allowed.example'] }))
    if (checked.diagnostics[0]?.code !== 'ADAPTER_NETWORK_PROHIBITED' || ssrfFetches !== 0) throw new Error('CONFORMANCE_SSRF_NOT_REJECTED_PRECONNECT')

    let redirectFetches = 0
    const redirect = new HttpAdapter(async () => { redirectFetches += 1; return new Response('', { status: 302, headers: { location: corpus.urls[0] } }) }, async () => [{ address: '203.0.113.10' }])
    const redirected = await redirect.check(request('redirect-downgrade', { url: corpus.urls[1] }, { offline: false, allowedHosts: ['allowed.example'] }))
    if (redirected.diagnostics[0]?.code !== 'ADAPTER_NETWORK_PROHIBITED' || redirectFetches !== 1) throw new Error('CONFORMANCE_REDIRECT_DOWNGRADE_NOT_REJECTED')

    const archiveKinds = /archive|compressed|gzip|tar|zip/iu
    if (createBuiltinAdapterRegistry().manifests.some(item => item.sourceKinds.some(kind => archiveKinds.test(kind)))) throw new Error('CONFORMANCE_UNQUALIFIED_DECOMPRESSION_SURFACE')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function qualifyStandardsGoldens(): Promise<void> {
  for (const [standard, version, path] of [['w3c-prov-json', '2013-04-30', 'test/fixtures/dataset/standards/prov-json-20130430.valid.json'], ['openlineage', '1.0.0', 'test/fixtures/dataset/standards/openlineage-1.0.0.valid.json']] as const) {
    const document = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8'))
    const imported = importStandard(standard, version, document)
    const exported = exportStandard(standard, version, imported.value)
    if (!exported.loss || exported.profile.id.length === 0) throw new Error(`CONFORMANCE_STANDARDS_LOSS_REPORT_MISSING:${standard}`)
  }
}
