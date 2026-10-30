import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildCorpusViews } from '../../../src/artifacts/corpus-views/build.js';
import { loadCorpus } from '../../../src/artifacts/corpus-views/ref-parser.js';
import { computeSnapshot } from '../../../src/artifacts/corpus-tools/snapshot.js';

describe('corpus grade fallback (#2571)', () => {
  let root: string;

  function write(relativePath: string, content: string): void {
    const fullPath = join(root, relativePath);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aiwg-corpus-grade-'));
    write('.aiwg/aiwg.config', JSON.stringify({
      version: '1', providers: ['claude'], installed: {}, scripts: {},
      index: { graphs: {
        summaries: { scanDirs: ['documentation/references'], extensions: ['.md'], defaultBuild: true },
        indices: { manifest: [{ name: 'by-grade' }, { name: 'radar-stale-queue' }] },
      } },
    }));
    write('documentation/references/REF-001-short.md', '---\nref_id: REF-001\ngrade: B\n---\n# Short\n');
    write('documentation/radar/REF-001-radar.md', '---\ngrade-current: B\n---\n');
    write('documentation/references/REF-1511-long.md', `---
ref_id: REF-1511
title: Long frontmatter
arxiv_id: '2601.01234'
doi: '10.1234/example'
url: https://example.test/paper
preprint_url: https://example.test/preprint
code_url: https://example.test/code
source_pdf: sources/pdfs/REF-1511.pdf
source_sha256: '${'a'.repeat(64)}'
issue_origin:
  tracker: example/project
  number: 42
tags: [indexing, research]
related_source_texts:
  - sources/text/REF-1511.txt
grade: ' A- '
---
# Long frontmatter
`);
    for (const [id, grade] of [
      ['1512', 'B+'], ['1513', null], ['1514', 'C'], ['1515', 'B-'],
      ['1516', null], ['1517', 'C+'], ['1518', 'A'], ['1519', 'C'],
      ['1520', ''], ['1521', null],
    ] as const) {
      const field = id === '1521' ? 'grade: null\n' : grade === null ? '' : `grade: "${grade}"\n`;
      write(`documentation/references/REF-${id}-paper.md`, `---\nref: REF-${id}\n${field}---\n# Paper ${id}\n`);
    }
    // An explicit current grade continues to override the reference grade.
    write('documentation/radar/REF-1514-radar.md', '---\ngrade-current: A\n---\n');
    // A radar can track freshness without carrying a grade.
    for (const id of ['1515', '1516']) {
      write(`documentation/radar/REF-${id}-radar.md`, '---\ngrade-current: null\nrefresh-cadence: annual\nlast-refreshed: 2024-01-01\n---\n');
    }
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('builds by-grade from short and long reference frontmatter without requiring radar sidecars', async () => {
    const expected = [
      '## A (2 papers)', '## A- (1 papers)', '## B (1 papers)', '## B- (1 papers)',
      '## C (1 papers)', '## B+ (1 papers)', '## C+ (1 papers)', '## Ungraded (4 papers)',
    ];
    for (const force of [false, true]) {
      const results = await buildCorpusViews(root, { force });
      expect(results.every((r) => r.status === 'built')).toBe(true);
      const output = readFileSync(join(root, 'indices/by-grade.md'), 'utf-8');
      expect(output.match(/^## .+$/gm)).toEqual(expected);
      expect(output).toMatch(/## A- \(1 papers\)\n\n- \*\*REF-1511\*\*/);
      expect(output.slice(output.indexOf('## Ungraded'))).not.toContain('REF-1511');
    }
    expect((await buildCorpusViews(root)).every((r) => r.status === 'skipped')).toBe(true);
  });

  it('resolves radar current grade before reference grade and keeps absent or empty grades null', () => {
    const { records } = loadCorpus(root);
    const grades = Object.fromEntries(records.map((r) => [r.refId, r.grade]));
    expect(grades).toEqual({
      'REF-001': 'B', 'REF-1511': 'A-', 'REF-1512': 'B+', 'REF-1513': null,
      'REF-1514': 'A', 'REF-1515': 'B-', 'REF-1516': null, 'REF-1517': 'C+',
      'REF-1518': 'A', 'REF-1519': 'C', 'REF-1520': null, 'REF-1521': null,
    });
    // The fallback must not invent radar coverage or freshness metadata.
    expect(records.find((r) => r.refId === 'REF-1511')!.radar).toBeNull();
    expect(records.find((r) => r.refId === 'REF-1515')!.radar!.gradeCurrent).toBeNull();
  });

  it('uses the reference grade in the stale-queue grade column when the radar grade is absent', async () => {
    await buildCorpusViews(root, { force: true });
    const output = readFileSync(join(root, 'indices/radar-stale-queue.md'), 'utf-8');
    expect(output).toContain('| REF-1515 | Paper 1515 | B- | annual |');
    expect(output).toContain('| REF-1516 | Paper 1516 | — | annual |');
    expect(output).not.toContain('| REF-1511 |');
  });

  it('counts reference grades in the corpus snapshot distribution', () => {
    const snapshot = computeSnapshot(root, { date: '2026-10-18' });
    expect(snapshot!.gradeDistribution).toEqual({ A: 2, 'A-': 1, B: 1, 'B-': 1, C: 1, D: 0, Missing: 4 });
    // Preserve the snapshot's existing controlled vocabulary (B+/C+ are off-vocabulary).
    expect(snapshot!.gradeOffVocabulary).toBe(2);
  });
});
