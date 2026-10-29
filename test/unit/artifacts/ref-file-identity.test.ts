// Verify shared REF lookup semantics and the public corpus-tool consumers.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refFilesForId } from '@/artifacts/corpus-tools/ref-files.js';
import { refTitle } from '@/artifacts/corpus-tools/sidecar-lint.js';
import { analysisRelPath, readAnalysisGrade } from '@/artifacts/corpus-tools/radar-shared.js';
import { auditInductions } from '@/artifacts/corpus-tools/induction-audit.js';
import { loadCorpus } from '@/artifacts/corpus-views/ref-parser.js';

describe('Exact corpus REF file identity', () => {
  let root: string;
  let refs: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ref-file-identity-'));
    refs = join(root, 'documentation', 'references');
    mkdirSync(refs, { recursive: true });
    mkdirSync(join(root, 'pdfs', 'full'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('preserves numeric spelling and suffixes and filters extensions and directories', () => {
    for (const name of ['REF-02.md', 'REF-020-paper.md', 'REF-020a-paper.md', 'REF-020-raw.pdf']) {
      writeFileSync(join(refs, name), '# Paper');
    }
    mkdirSync(join(refs, 'REF-020-directory.md'));
    expect(refFilesForId(refs, 'REF-2')).toEqual([]);
    expect(refFilesForId(refs, 'REF-02')).toEqual(['REF-02.md']);
    expect(refFilesForId(refs, 'REF-020')).toEqual(['REF-020-paper.md']);
    expect(refFilesForId(refs, 'REF-020a')).toEqual(['REF-020a-paper.md']);
    expect(refFilesForId(refs, 'REF-020', '.pdf')).toEqual(['REF-020-raw.pdf']);
    for (const ref of ['', ' ', 'REF-', 'REF-020-paper']) expect(refFilesForId(refs, ref)).toEqual([]);
  });

  it('title and radar readers ignore directories and wrong extensions', () => {
    mkdirSync(join(refs, 'REF-020-a-directory.md'));
    writeFileSync(join(refs, 'REF-020-b-raw.pdf'), '# Wrong title');
    writeFileSync(join(refs, 'REF-020-c-paper.md'), '# Correct title\n**Quality**: A');
    expect(refTitle(root, 'REF-020')).toBe('Correct title');
    expect(readAnalysisGrade(root, 'REF-020')).toBe('A');
    expect(analysisRelPath(root, 'REF-020')).toBe('documentation/references/REF-020-c-paper.md');
    expect(refTitle(root, 'REF')).toBe('?');
  });

  it('induction PDF checks reject directories and non-PDF slug matches', () => {
    mkdirSync(join(refs, 'REF-020-paper.md'));
    mkdirSync(join(root, 'pdfs', 'full', 'REF-020-dir.pdf'));
    writeFileSync(join(root, 'pdfs', 'full', 'REF-020-paper.txt'), 'Not PDF');
    const [result] = auditInductions(root, { refs: ['REF-020'] });
    expect(result.analysisExists).toBe(false);
    expect(result.pdfExists).toBe(false);
  });

  it('corpus resolution uses the same token parser for bare names and padding', () => {
    writeFileSync(join(refs, 'REF-02.md'), '# Two');
    writeFileSync(join(refs, 'REF-020a-paper.md'), '# Suffix');
    expect(loadCorpus(root).records.map(record => record.refId).sort()).toEqual(['REF-02', 'REF-020a']);
  });
});
