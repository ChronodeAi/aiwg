import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import {
  DATASET_CONFORMANCE_CONTRACT,
  DATASET_CONFORMANCE_SCHEMA_VERSION,
  type DatasetConformanceCell,
  type DatasetConformanceCellResult,
  type DatasetConformanceManifest,
  type DatasetConformanceReceipt,
} from '../../src/dataset/conformance-types.js'
import { conformanceDigest, resultDigest, summarizeConformance, verifyConformanceReceipt } from '../../src/dataset/conformance.js'
import { CsvAdapter, DirectoryAdapter, FileAdapter, HttpAdapter, JsonlAdapter } from '../../src/dataset/adapters.js'
import { request, sha256Digest } from '../../src/dataset/adapter-sdk.js'
import { verifyFortemiDatasetExecutionQualification } from '../../src/dataset/fortemi-live-qualification.js'
import { qualifyAdversarialAdapters, qualifyCapabilityBinding, qualifyCheckpointBoundaries, qualifyOfflineMatrix, qualifyProvenanceBinding, qualifyReplay, qualifyStandardsGoldens } from './dataset-local-cells.js'

interface Arguments { manifest: string; report?: string; mode: 'local' | 'cross-repo' | 'live'; fortemiCheckout?: string; fortemiCommit?: string; fortemiServerCommit?: string; liveQualification?: string; liveRunReceipt?: string; verify?: string }

function argumentsFrom(argv: string[]): Arguments {
  const value = (name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined }
  const mode = (value('--mode') ?? 'local') as Arguments['mode']
  if (!['local', 'cross-repo', 'live'].includes(mode)) throw new Error(`Unsupported mode ${mode}`)
  return { manifest: value('--manifest') ?? 'test/fixtures/dataset-intelligence/v1/manifest.json', report: value('--report'), mode, fortemiCheckout: value('--fortemi-checkout'), fortemiCommit: value('--fortemi-commit'), fortemiServerCommit: value('--fortemi-server-commit'), liveQualification: value('--live-qualification'), liveRunReceipt: value('--live-run-receipt'), verify: value('--verify') }
}

async function digestFile(path: string): Promise<string> { return `sha256:${sha256Digest(await readFile(path)).value}` }

async function fixtureEvidence(cell: DatasetConformanceCell) {
  const actual = await digestFile(cell.fixture.path)
  if (actual !== cell.fixture.digest) throw new Error(`CONFORMANCE_FIXTURE_DIGEST_MISMATCH: ${cell.fixture.path}`)
  return { kind: 'fixture' as const, reference: cell.fixture.path, digest: actual }
}

async function runAdapter(cell: DatasetConformanceCell): Promise<DatasetConformanceCellResult> {
  const evidence = await fixtureEvidence(cell)
  const sourceRoot = resolve('test/fixtures/dataset-intelligence/v1/sources')
  const body = cell.sourceClass === 'http' ? await readFile(cell.fixture.path, 'utf8') : ''
  let fetchAttempts = 0
  const controlledFetch: typeof fetch = async input => {
    fetchAttempts += 1
    return new URL(String(input)).pathname === '/source'
      ? new Response('', { status: 307, headers: { location: '/v2' } })
      : new Response(body, { status: 200, headers: { 'content-length': String(Buffer.byteLength(body)) } })
  }
  const adapter = cell.sourceClass === 'jsonl' ? new JsonlAdapter()
    : cell.sourceClass === 'csv' ? new CsvAdapter()
      : cell.sourceClass === 'file' ? new FileAdapter()
        : cell.sourceClass === 'directory' ? new DirectoryAdapter()
          : cell.sourceClass === 'http' ? new HttpAdapter(
            controlledFetch,
            async () => [{ address: '203.0.113.10' }],
          ) : undefined
  if (!adapter) throw new Error(`CONFORMANCE_ADAPTER_UNSUPPORTED: ${cell.sourceClass}`)
  const config = cell.sourceClass === 'directory' ? { path: resolve(sourceRoot, 'directory'), recursive: true }
    : cell.sourceClass === 'http' ? { url: 'https://dataset.example.test/source' }
      : { path: resolve(cell.fixture.path) }
  const policy = cell.sourceClass === 'http'
    ? { offline: false, allowedHosts: ['dataset.example.test'] }
    : { offline: true, allowedRoot: sourceRoot }
  const configured = await adapter.configure(config)
  if (!configured.ok || !configured.config) throw new Error(configured.diagnostics[0]?.code ?? 'ADAPTER_INVALID_CONFIGURATION')
  const adapterRequest = request(cell.id, configured.config, policy, cell.resourceEnvelope)
  const checked = await adapter.check(adapterRequest)
  const discovered = await adapter.discover(adapterRequest)
  const previewed = await adapter.preview({ ...adapterRequest, count: 2 })
  let records = 0
  for await (const event of adapter.read(adapterRequest)) if (event.kind === 'record') records += 1
  const expectedRecords = cell.sourceClass === 'jsonl' ? 3 : cell.sourceClass === 'csv' ? 4 : cell.sourceClass === 'directory' ? 2 : 1
  if (!checked.ok || !discovered.ok || !previewed.ok || records !== expectedRecords) throw new Error('CONFORMANCE_ADAPTER_LIFECYCLE_FAILED')
  const sourceEvidence = cell.evidence.includes('real-source')
    ? [{ kind: 'real-source' as const, reference: cell.sourceClass === 'directory' ? resolve(sourceRoot, 'directory') : resolve(cell.fixture.path), digest: evidence.digest }]
    : []
  return { cellId: cell.id, status: 'passed', evidence: [evidence, ...sourceEvidence], observed: { records, bytes: (await stat(cell.fixture.path)).size, durationMs: 0, networkAttempts: fetchAttempts } }
}

async function runBoundCell(cell: DatasetConformanceCell, qualify: () => Promise<void>): Promise<DatasetConformanceCellResult> {
  const evidence = await fixtureEvidence(cell)
  await qualify()
  return { cellId: cell.id, status: 'passed', evidence: [evidence], observed: { records: 0, bytes: (await stat(cell.fixture.path)).size, durationMs: 0, networkAttempts: 0 } }
}

async function pending(cell: DatasetConformanceCell): Promise<DatasetConformanceCellResult> {
  return { cellId: cell.id, status: 'pending', diagnostic: cell.expected.diagnostic ?? 'CONFORMANCE_EVIDENCE_PENDING', evidence: [await fixtureEvidence(cell)], observed: { networkAttempts: 0 } }
}

async function runFortemiParity(cell: DatasetConformanceCell, checkout: string, commit: string): Promise<DatasetConformanceCellResult> {
  const fixture = await fixtureEvidence(cell)
  execFileSync('pnpm', ['--dir', checkout, '--filter', '@fortemi/core', 'exec', 'vitest', 'run',
    'src/__tests__/dataset-execution-capabilities.test.ts',
    'src/__tests__/dataset-ingest.test.ts',
    'src/__tests__/dataset-lineage.test.ts',
    'src/__tests__/dataset-materialization-profiles.test.ts'], { stdio: 'inherit' })
  const lockDigest = await digestFile(resolve(checkout, 'pnpm-lock.yaml'))
  return { cellId: cell.id, status: 'passed', evidence: [fixture, { kind: 'cross-repo', reference: `${checkout}@${commit}`, digest: lockDigest }], observed: { records: 0, bytes: (await stat(cell.fixture.path)).size, durationMs: 0, networkAttempts: 0 } }
}

async function runFortemiLive(cell: DatasetConformanceCell, qualificationPath: string, runReceiptPath: string, commit: string): Promise<DatasetConformanceCellResult> {
  const fixture = await fixtureEvidence(cell)
  const qualification = JSON.parse(await readFile(qualificationPath, 'utf8')) as unknown
  const runReceipt = JSON.parse(await readFile(runReceiptPath, 'utf8')) as unknown
  const diagnostics = verifyFortemiDatasetExecutionQualification({ qualification, runReceipt, expectedFortemiCommit: commit })
  if (diagnostics.length) throw new Error(diagnostics.join(','))
  const receipt = runReceipt as { counts: { committed: number }, resourceEnvelope: { maxInputBytes: number } }
  return {
    cellId: cell.id,
    status: 'passed',
    evidence: [
      fixture,
      { kind: 'live-qualification', reference: resolve(qualificationPath), digest: await digestFile(qualificationPath) },
      { kind: 'live-qualification', reference: resolve(runReceiptPath), digest: await digestFile(runReceiptPath) },
    ],
    observed: { records: receipt.counts.committed, bytes: receipt.resourceEnvelope.maxInputBytes, networkAttempts: 1 },
  }
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2))
  const manifest = JSON.parse(await readFile(args.manifest, 'utf8')) as DatasetConformanceManifest
  if (args.verify) {
    const receipt = JSON.parse(await readFile(args.verify, 'utf8')) as DatasetConformanceReceipt
    const diagnostics = verifyConformanceReceipt(manifest, receipt)
    console.log(JSON.stringify({ valid: diagnostics.length === 0, diagnostics }, null, 2))
    process.exitCode = diagnostics.length === 0 ? 0 : 1
    return
  }
  const aiwgDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()
  if (aiwgDirty) throw new Error('CONFORMANCE_AIWG_CHECKOUT_DIRTY')
  if (args.mode === 'live') {
    if (!args.liveQualification || !args.liveRunReceipt || !args.fortemiServerCommit || !/^[0-9a-f]{40}$/u.test(args.fortemiServerCommit)) {
      throw new Error('CONFORMANCE_LIVE_AUTHORIZATION_REQUIRED: --live-qualification, --live-run-receipt, and --fortemi-server-commit are required')
    }
  }
  if (args.mode === 'cross-repo' || (args.mode === 'live' && args.fortemiCheckout)) {
    if (!args.fortemiCheckout || !args.fortemiCommit || !/^[0-9a-f]{40}$/u.test(args.fortemiCommit)) throw new Error('CONFORMANCE_PINNED_FORTEMI_REQUIRED')
    const actual = execFileSync('git', ['-C', args.fortemiCheckout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    if (actual !== args.fortemiCommit) throw new Error(`CONFORMANCE_FORTEMI_COMMIT_MISMATCH: expected ${args.fortemiCommit}, received ${actual}`)
    const dirty = execFileSync('git', ['-C', args.fortemiCheckout, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()
    if (dirty) throw new Error('CONFORMANCE_FORTEMI_CHECKOUT_DIRTY')
  }
  const startedAt = new Date().toISOString()
  const results: DatasetConformanceCellResult[] = []
  for (const cell of manifest.cells) {
    try {
      if (cell.id.startsWith('adapter.')) results.push(await runAdapter(cell))
      else if (cell.id === 'capability.plan-binding') results.push(await runBoundCell(cell, qualifyCapabilityBinding))
      else if (cell.id === 'replay.orchestration') results.push(await runBoundCell(cell, qualifyReplay))
      else if (cell.id === 'checkpoint.crash-boundaries') results.push(await runBoundCell(cell, qualifyCheckpointBoundaries))
      else if (cell.id === 'security.adapter-adversarial') results.push(await runBoundCell(cell, qualifyAdversarialAdapters))
      else if (cell.id === 'offline.cache-matrix') results.push(await runBoundCell(cell, qualifyOfflineMatrix))
      else if (cell.id === 'provenance.complete') results.push(await runBoundCell(cell, qualifyProvenanceBinding))
      else if (cell.id === 'standards.prov-openlineage') results.push(await runBoundCell(cell, qualifyStandardsGoldens))
      else if (cell.id === 'parity.fortemi-core' && args.mode !== 'local' && args.fortemiCheckout && args.fortemiCommit) results.push(await runFortemiParity(cell, args.fortemiCheckout, args.fortemiCommit))
      else if (cell.id === 'parity.fortemi-server-live' && args.mode === 'live' && args.liveQualification && args.liveRunReceipt && args.fortemiServerCommit) results.push(await runFortemiLive(cell, args.liveQualification, args.liveRunReceipt, args.fortemiServerCommit))
      else results.push(await pending(cell))
    } catch (error) {
      results.push({ cellId: cell.id, status: 'failed', diagnostic: error instanceof Error ? error.message : 'CONFORMANCE_UNKNOWN_FAILURE', evidence: [], observed: { networkAttempts: 0 } })
    }
  }
  const schemaPaths = ['schemas/dataset/conformance-manifest.v1.schema.json', 'schemas/dataset/conformance-receipt.v1.schema.json']
  const receipt: DatasetConformanceReceipt = {
    contract: DATASET_CONFORMANCE_CONTRACT, schemaVersion: DATASET_CONFORMANCE_SCHEMA_VERSION, corpusVersion: manifest.corpusVersion,
    manifestDigest: conformanceDigest(manifest), resultDigest: resultDigest(results),
    bindings: {
      aiwgCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      ...(args.fortemiCheckout ? { fortemiCommit: args.fortemiCommit } : {}),
      ...(args.mode === 'live' ? { fortemiServerCommit: args.fortemiServerCommit } : {}),
      packageDigests: { aiwg: await digestFile('package-lock.json'), ...(args.fortemiCheckout ? { fortemi: await digestFile(resolve(args.fortemiCheckout, 'pnpm-lock.yaml')) } : {}) },
      schemaDigests: Object.fromEntries(await Promise.all(schemaPaths.map(async path => [path, await digestFile(path)]))),
      fixtureDigest: await digestFile('test/fixtures/dataset-intelligence/v1/digest-manifest.json'),
      configurationDigest: conformanceDigest({ mode: args.mode, fortemiCommit: args.fortemiCommit, fortemiServerCommit: args.fortemiServerCommit }),
    },
    startedAt, endedAt: new Date().toISOString(), results, summary: summarizeConformance(manifest, results),
  }
  const output = `${JSON.stringify(receipt, null, 2)}\n`
  if (args.report) {
    await mkdir(dirname(resolve(args.report)), { recursive: true })
    await writeFile(args.report, output)
  } else process.stdout.write(output)
  if (receipt.summary.failed > 0) process.exitCode = 1
}

await main()
