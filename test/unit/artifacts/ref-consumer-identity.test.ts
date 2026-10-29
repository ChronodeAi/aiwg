// Exercise audited REF consumers using synthetic local files and metadata.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactIndex as HybridIndex } from '@/artifacts/hybrid-query.js';
import type { ArtifactIndex, MetadataEntry } from '@/artifacts/types.js';
import { runResearchQuery } from '@/research/query-cli.js';
import { runRetrievalLab, RETRIEVAL_LAB_STRATEGIES } from '@/artifacts/corpus-tools/retrieval-lab.js';
import { findOrphans } from '@/artifacts/corpus-tools/sidecar-lint.js';
import { extractCrossrefs } from '@/artifacts/corpus-tools/citation-densify.js';
import { scanCorpus } from '@/artifacts/corpus-tools/integrity-scan.js';
import { expandCli } from '@/artifacts/corpus-tools/expand-cli.js';

let root: string;
function doc(rel: string, body: string) {
  const file = join(root, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, body);
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ref-consumer-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('hybrid dependency paths and dependent REF IDs cannot match filename substrings', async () => {
  doc('.aiwg/refs/XREF-02.md', '# Wrong');
  doc('.aiwg/refs/REF-020.md', '# Wrong width');
  doc('.aiwg/refs/REF-02.md', '# Right');
  doc('.aiwg/source.md', '@REF-02.md');
  doc('.aiwg/wrong.md', '@refs/REF-020.md');
  const index = new HybridIndex(root);
  await index.build();
  expect(index.findDependencies('source.md').map(a => a.relativePath)).toEqual(['refs/REF-02.md']);
  expect(index.findDependents('REF-02').map(a => a.relativePath)).toEqual(['source.md']);
});

it('query and retrieval IDs retain uppercase suffixes and reject malformed prefixes', async () => {
  const entries: MetadataEntry[] = ['REF-02', 'REF-12345', 'REF-020A', 'REF-020a', 'REF-020aa'].map(id => ({
    path: `.aiwg/research/findings/${id}-paper.md`, type: 'research-ref', phase: 'research',
    name: id, title: `${id} retrieval`, summary: 'retrieval evidence', tags: ['retrieval'],
    created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', checksum: id,
    dependencies: [], dependents: [],
  }));
  const index: ArtifactIndex = { version: '1.0.0', builtAt: '2026-01-01T00:00:00Z', buildTimeMs: 1,
    entries: Object.fromEntries(entries.map(e => [e.path, e])) };
  doc('.aiwg/.index/project/metadata.json', JSON.stringify(index));
  for (const e of entries) doc(e.path, '# Retrieval\nretrieval evidence');
  const expected = ['REF-02', 'REF-12345', 'REF-020A', 'REF-020a', 'REF-020aa-paper'].sort();
  const result = await runResearchQuery(root, { question: 'retrieval', backend: 'local' });
  expect(result.sources.map(s => s.id).sort()).toEqual(expected);
  doc('queries.jsonl', JSON.stringify({ schema: 'aiwg.corpus-retrieval-query/v1', id: 'q', question: 'retrieval',
    expected_ids: ['REF-020A'], expected_evidence: ['retrieval'] }));
  doc('concepts.json', JSON.stringify({ schema: 'aiwg.concept-scheme/v1', id: 'concepts',
    concepts: [{ id: 'retrieval', prefLabel: 'retrieval' }] }));
  const report = await runRetrievalLab({ root, queriesPath: join(root, 'queries.jsonl'), conceptsPath: join(root, 'concepts.json') });
  for (const strategy of RETRIEVAL_LAB_STRATEGIES) {
    expect(report.queries[0].results[strategy].map(hit => hit.id).sort()).toEqual(expected);
  }
});

it('orphan detection ignores malformed tokens and sees uppercase edges', () => {
  doc('documentation/citations/REF-001-citations.md', '## Outgoing\n| REF-020aa | XREF-020 |');
  doc('documentation/citations/REF-002-citations.md', '## Outgoing\n| REF-020A |');
  expect(findOrphans(root).map(o => o.ref)).toEqual(['REF-001']);
});

it('densification keeps suffix case and does not invent an unsuffixed edge', () => {
  doc('documentation/references/REF-001-paper.md', '## Cross-References\nREF-020A REF-020aa XREF-020');
  for (const ref of ['REF-001', 'REF-020', 'REF-020A']) {
    doc(`documentation/citations/${ref}-citations.md`, '## Outgoing\n## Incoming');
  }
  expect(extractCrossrefs(root).perSource).toEqual({ 'REF-001': ['REF-020A'] });
});

it('integrity REF filter excludes longer IDs, suffixes and matching directory names', () => {
  for (const ref of ['REF-02', 'REF-020', 'REF-02a', 'REF-02A']) {
    doc(`documentation/references/${ref}-paper.md`, 'TODO: add the methodology.');
  }
  doc('documentation/references/REF-02/fake.md', 'TODO: add the methodology.');
  expect(scanCorpus(root, { ref: 'REF-02' }).findings.map(f => f.ref)).toEqual(['REF-02']);
});

it('expansion accepts uppercase seed syntax before checking corpus membership without requests', async () => {
  await expect(expandCli(['--seeds', 'REF-020A'], root, root)).rejects.toThrow('Every --seeds REF must exist');
});
