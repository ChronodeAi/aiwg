// Pin REF token identity across corpus, graph, and citation consumers.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCorpus } from '@/artifacts/corpus-views/ref-parser.js';
import { refFilesForId } from '@/artifacts/corpus-tools/ref-files.js';
import { resolveNode } from '@/artifacts/graph-query.js';
import { extractRefsFromTable, isNodeId } from '@/artifacts/citation-parser.js';
import { auditInductions } from '@/artifacts/corpus-tools/induction-audit.js';
import { scanCorpus } from '@/artifacts/corpus-tools/integrity-scan.js';
import { listRadarRefs, listCitationRefs } from '@/artifacts/corpus-tools/radar-shared.js';
import { compareRefId, isRefId, refSortKey } from '@/research/identity.js';

let root: string;
function doc(rel: string, body: string) {
  const file = join(root, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, body);
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ref-token-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('F3 links arbitrary-width IDs without truncating malformed tokens', () => {
  doc('documentation/references/REF-001-paper.md', '# Paper');
  doc('documentation/citations/REF-001-citations.md',
    '## Outgoing\n| REF-02 | REF-12345 | REF-020aa | XREF-020 | REF-9999extra |');
  expect([...loadCorpus(root).records[0].outgoing]).toEqual(['REF-02', 'REF-12345']);
});

it('F4 accepts suffix case without merging exact identities or sort suffixes', () => {
  const refs = ['REF-020', 'REF-020a', 'REF-020A'];
  for (const ref of refs) doc(`documentation/references/${ref}-paper.md`, '# Paper');
  const dir = join(root, 'documentation/references');
  for (const ref of refs) {
    expect(isRefId(ref)).toBe(true);
    expect(refFilesForId(dir, ref)).toEqual([`${ref}-paper.md`]);
  }
  expect(loadCorpus(root).records.map(r => r.refId).sort()).toEqual([...refs].sort());
  expect(refSortKey('REF-020A')).toEqual([20, 'A']);
  expect(compareRefId('REF-020A', 'REF-020a')).not.toBe(0);
  expect(refSortKey('REF-020aa')).toEqual([999999, 'REF-020aa']);
});

it('graph shorthand resolves complete basename tokens only', () => {
  const graph = Object.fromEntries(['REF-020', 'REF-020a', 'REF-020A'].map(ref =>
    [`refs/${ref}-paper.md`, { upstream: [], downstream: [] }]));
  expect(resolveNode(graph, 'REF-02')).toBeNull();
  expect(resolveNode(graph, 'REF-2')).toBeNull();
  for (const ref of ['REF-020', 'REF-020a', 'REF-020A']) {
    expect(resolveNode(graph, ref)).toBe(`refs/${ref}-paper.md`);
  }
});

it('citation columns retain uppercase suffixes and reject malformed token prefixes', () => {
  expect(isNodeId('REF-020A')).toBe(true);
  const table = '| REF |\n| --- |\n| REF-02 REF-12345 REF-020a REF-020A REF-020aa XREF-020 |';
  expect(extractRefsFromTable(table, 'REF')).toEqual(['REF-02', 'REF-12345', 'REF-020a', 'REF-020A']);
});

it('induction discovery keeps short, long and uppercase identities and ignores malformed files', () => {
  for (const ref of ['REF-02', 'REF-12345', 'REF-020A', 'REF-020aa']) {
    doc(`documentation/references/${ref}-paper.md`, '# Paper');
  }
  expect(auditInductions(root).map(r => r.ref)).toEqual(['REF-02', 'REF-020A', 'REF-12345']);
});

it('integrity findings group by whole filename token rather than a REF prefix', () => {
  for (const ref of ['REF-02', 'REF-12345', 'REF-020A', 'REF-020aa']) {
    doc(`documentation/references/${ref}-paper.md`, 'TODO: add the methodology.');
  }
  expect(Object.keys(scanCorpus(root).summary).sort()).toEqual(['NO-REF', 'REF-02', 'REF-020A', 'REF-12345']);
});

it('radar and citation discovery accept the same shape as identity', () => {
  for (const ref of ['REF-02', 'REF-12345', 'REF-020a', 'REF-020A', 'REF-020aa']) {
    doc(`documentation/radar/${ref}-radar.md`, '# Radar');
    doc(`documentation/citations/${ref}-citations.md`, '# Citations');
  }
  const expected = ['REF-02', 'REF-020A', 'REF-020a', 'REF-12345'];
  expect(listRadarRefs(root)).toEqual(expected);
  expect(listCitationRefs(root)).toEqual(expected);
});
