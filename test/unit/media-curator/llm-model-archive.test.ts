import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHECKSUM_FILE,
  PROVENANCE_FILE,
  buildFixityManifest,
  buildProvenanceRecord,
  parseFixityManifest,
  verifyFixityManifest,
  writeProvenanceRecord,
} from '../../../tools/media-curator/llm-model-archive.mjs';
import {
  lintReport,
  renderInventory,
  renderReport,
  validateInventory,
  validateInventoryEntry,
} from '../../../tools/media-curator/llm-model-report.mjs';

const HEX64 = /^[0-9a-f]{64}$/;

function entry(overrides: Record<string, unknown> = {}) {
  return {
    model_id: 'example-org/example-8b',
    revision: '0123456789abcdef0123456789abcdef01234567',
    precision: 'bf16',
    parameter_count: '8B',
    license: 'apache-2.0',
    downloads: { count: 1234567, captured_at: '2026-09-13' },
    benchmarks: [
      { name: 'MMLU', score: 66.1, source_url: 'https://huggingface.co/example-org/example-8b', date: '2026-09-13' },
    ],
    archive_path: '/archive/llm/example-org__example-8b/0123456789abcdef0123456789abcdef01234567',
    files: [{ path: 'model-00001-of-00001.safetensors', sha256: 'a'.repeat(64) }],
    status: 'archived',
    ...overrides,
  };
}

describe('llm-model-archive fixity (#2554)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'llm-archive-'));
    writeFileSync(join(dir, 'model-00001-of-00002.safetensors'), Buffer.alloc(4096, 1));
    writeFileSync(join(dir, 'model-00002-of-00002.safetensors'), Buffer.alloc(4096, 2));
    writeFileSync(join(dir, 'config.json'), '{"architectures":["ExampleForCausalLM"]}\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a self-verifying manifest and verifies a clean archive', async () => {
    const manifest = await buildFixityManifest(dir, { now: new Date('2026-09-13T20:00:00Z') });
    expect(manifest.entries.map(e => e.path)).toEqual(['config.json', 'model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors']);
    expect(manifest.entries.every(e => HEX64.test(e.sha256))).toBe(true);
    const text = readFileSync(join(dir, CHECKSUM_FILE), 'utf8');
    expect(text.startsWith(`# MANIFEST_HASH: ${manifest.manifestHash}\n# Generated: 2026-09-13T20:00:00.000Z\n# Verify with: tail -n +4 CHECKSUMS.sha256 | sha256sum\n`)).toBe(true);
    const parsed = parseFixityManifest(text);
    expect(parsed.bodyHash).toBe(parsed.manifestHash);
    expect(parsed.entries).toHaveLength(3);

    const result = await verifyFixityManifest(dir);
    expect(result).toMatchObject({ ok: true, manifestIntact: true, verified: 3, missing: [], corrupted: [], extra: [], errors: [] });
  });

  it('detects a corrupted shard', async () => {
    const manifest = await buildFixityManifest(dir);
    writeFileSync(join(dir, 'model-00002-of-00002.safetensors'), Buffer.alloc(4096, 3));
    const result = await verifyFixityManifest(dir);
    expect(result.ok).toBe(false);
    expect(result.manifestIntact).toBe(true);
    expect(result.corrupted).toHaveLength(1);
    expect(result.corrupted[0]).toMatchObject({ path: 'model-00002-of-00002.safetensors', expected: manifest.entries[2].sha256 });
    expect(result.corrupted[0].actual).not.toBe(manifest.entries[2].sha256);
    expect(result.verified).toBe(2);
  });

  it('detects a missing shard and reports untracked extras without failing on them', async () => {
    await buildFixityManifest(dir);
    unlinkSync(join(dir, 'model-00001-of-00002.safetensors'));
    writeFileSync(join(dir, 'notes.txt'), 'added after the manifest');
    const result = await verifyFixityManifest(dir);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['model-00001-of-00002.safetensors']);
    expect(result.extra).toEqual(['notes.txt']);
    expect(result.corrupted).toEqual([]);
  });

  it('fails closed on a tampered or absent manifest', async () => {
    expect((await verifyFixityManifest(dir)).errors[0]).toMatch(/not found/);
    await buildFixityManifest(dir);
    const path = join(dir, CHECKSUM_FILE);
    writeFileSync(path, readFileSync(path, 'utf8').replace('config.json', 'renamed.json'));
    const result = await verifyFixityManifest(dir);
    expect(result.manifestIntact).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/MANIFEST_HASH/);
  });

  it('refuses an empty archive directory', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'llm-archive-empty-'));
    try {
      await expect(buildFixityManifest(empty)).rejects.toThrow(/no files/);
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
});

describe('llm-model-archive provenance (#2554)', () => {
  const fixity = { manifestHash: 'b'.repeat(64), fileCount: 3, generatedAt: '2026-09-13T20:00:00.000Z' };
  const spec = {
    modelId: 'example-org/example-8b', revision: '0123456789abcdef0123456789abcdef01234567', precision: 'bf16', parameterCount: '8B',
    license: 'apache-2.0', sourceUrl: 'https://huggingface.co/example-org/example-8b', archivePath: '/archive/llm/example-org__example-8b/0123456789abcdef0123456789abcdef01234567',
    downloads: { count: 1234567, capturedAt: '2026-09-13' }, agent: { name: 'llm-model-archivist', version: '2026.9.9' }, fixity,
  };

  it('requires every identifying field and a fixity hash', () => {
    expect(() => buildProvenanceRecord({ ...spec, license: '' })).toThrow(/missing required fields: license/);
    expect(() => buildProvenanceRecord({ ...spec, fixity: undefined })).toThrow(/fixity.manifestHash/);
  });

  it('emits a PROV-O + PREMIS record binding the model to its source and its manifest hash', () => {
    const record = buildProvenanceRecord(spec);
    expect(record['@context']).toMatchObject({ prov: 'http://www.w3.org/ns/prov#', premis: 'http://www.loc.gov/premis/rdf/v3/' });
    const [collection, source, activity, agent] = record['@graph'];
    expect(collection['@type']).toBe('prov:Collection');
    expect(collection['dc:license']).toBe('apache-2.0');
    expect(collection['prov:wasDerivedFrom']).toEqual({ '@id': source['@id'] });
    expect(collection['premis:hasFixity']).toMatchObject({ 'premis:messageDigest': fixity.manifestHash, 'schema:url': CHECKSUM_FILE, 'schema:numberOfItems': 3 });
    expect(source['schema:url']).toBe(spec.sourceUrl);
    expect(source['schema:interactionStatistic']).toMatchObject({ 'schema:userInteractionCount': 1234567, 'schema:observationDate': '2026-09-13' });
    expect(activity['prov:generated']).toEqual({ '@id': collection['@id'] });
    expect(activity['prov:wasAssociatedWith']).toEqual({ '@id': agent['@id'] });
    expect(agent['schema:softwareVersion']).toBe('2026.9.9');
    const dir = mkdtempSync(join(tmpdir(), 'llm-prov-'));
    try {
      const path = writeProvenanceRecord(dir, record);
      expect(path.endsWith(PROVENANCE_FILE)).toBe(true);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(record);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('llm-model-report inventory and report (#2554)', () => {
  it('accepts a complete entry and names every missing required field', () => {
    expect(validateInventoryEntry(entry())).toEqual([]);
    const errors = validateInventoryEntry({ model_id: 'x/y' });
    for (const field of ['revision', 'precision', 'parameter_count', 'license', 'downloads', 'benchmarks', 'archive_path', 'files', 'status']) {
      expect(errors).toContain(`missing required field: ${field}`);
    }
  });

  it('rejects undated popularity, unsourced benchmarks, bad hashes, and unrequested quantized archives', () => {
    expect(validateInventoryEntry(entry({ downloads: { count: 5 } }))).toContainEqual(expect.stringMatching(/captured_at/));
    expect(validateInventoryEntry(entry({ benchmarks: [{ name: 'MMLU', score: 66.1 }] }))).toEqual(expect.arrayContaining([
      expect.stringMatching(/source_url/), expect.stringMatching(/date/),
    ]));
    expect(validateInventoryEntry(entry({ files: [{ path: 'a', sha256: 'nope' }] }))).toContainEqual(expect.stringMatching(/sha256/));
    expect(validateInventoryEntry(entry({ precision: 'Q4_K_M' }))).toContainEqual(expect.stringMatching(/original precision/));
    expect(validateInventoryEntry(entry({ precision: 'Q4_K_M', explicitly_requested: true }))).toEqual([]);
    expect(validateInventoryEntry(entry({ precision: 'Q4_K_M', status: 'flagged-quantized-only', files: [] }))).toEqual([]);
    expect(validateInventory([entry(), entry({ status: 'bogus' })])).toEqual([{ index: 1, model_id: 'example-org/example-8b', errors: [expect.stringMatching(/status/)] }]);
  });

  it('renders the inventory with every required column and per-file SHA-256 lines', () => {
    const markdown = renderInventory([entry()], { generatedAt: '2026-09-13T20:00:00.000Z' });
    expect(markdown).toContain('| Model | Revision | Precision | Params | License | Downloads (captured) | Benchmarks (source, date) | Status | Archive path | Files |');
    expect(markdown).toContain('| example-org/example-8b | `0123456789abcdef0123456789abcdef01234567` | bf16 | 8B | apache-2.0 | 1234567 (2026-09-13) | MMLU 66.1 ([source](https://huggingface.co/example-org/example-8b), 2026-09-13) | archived |');
    expect(markdown).toContain(`${'a'.repeat(64)}  ./model-00001-of-00001.safetensors`);
    expect(lintReport(markdown).ok).toBe(true);
  });

  it('renders a report whose sourced numbers pass the lint', () => {
    const markdown = renderReport({
      title: '8-9B candidates',
      criteria: 'original-precision safetensors only',
      candidates: [entry({ status: 'candidate' })],
      flagged: [{ model_id: 'example-org/example-8b-gguf', precision: 'Q4_K_M', reason: 'publishes GGUF only' }],
      recommendations: ['Archive example-org/example-8b.'],
      generatedAt: '2026-09-13T20:00:00.000Z',
    });
    expect(markdown).toContain('## Flagged: quantized-only');
    expect(markdown).toContain('- example-org/example-8b-gguf (Q4_K_M): publishes GGUF only');
    expect(markdown).toContain('1. https://huggingface.co/example-org/example-8b');
    expect(lintReport(markdown)).toEqual({ ok: true, findings: [] });
  });

  it('fails the lint on unsourced or undated benchmark figures and on hub credentials', () => {
    const unsourced = lintReport('| MMLU | 66.1 |\n');
    expect(unsourced.ok).toBe(false);
    expect(unsourced.findings.map(f => f.rule)).toEqual(['unsourced-number', 'undated-number']);
    const undated = lintReport('GSM8K 79.4 (https://example.org/paper)\n');
    expect(undated.findings.map(f => f.rule)).toEqual(['undated-number']);
    const leak = lintReport(`Fetched with hf_${'A'.repeat(30)} from the hub.\n`);
    expect(leak.ok).toBe(false);
    expect(leak.findings[0]).toMatchObject({ rule: 'credential-leak', severity: 'error' });
    expect(lintReport('HF_TOKEN=abc123 curl ...\n').ok).toBe(false);
  });

  it('warns on overclaiming without failing the lint', () => {
    const result = lintReport('The paper proves this model is the strongest 8B release.\n');
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([expect.objectContaining({ rule: 'overclaim', severity: 'warning' })]);
  });
});
