// Exercise the real citation validator against isolated corpus files.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CitationService } from '@/research/services/citation.js';

describe('CitationService exact REF validation', () => {
  let corpus: string;
  let service: CitationService;
  beforeEach(async () => {
    corpus = await mkdtemp(join(tmpdir(), 'citation-validation-'));
    service = new CitationService({ corpusPath: corpus });
  });
  afterEach(async () => { await rm(corpus, { recursive: true, force: true }); });

  it('does not validate REF-02 against REF-020', async () => {
    await writeFile(join(corpus, 'REF-020-paper.md'), '# Paper');
    expect(await service.validateCitation('REF-02')).toBe(false);
    expect(await service.validateCitation('REF-020')).toBe(true);
  });

  it('preserves zero padding rather than equating REF-2 and REF-02', async () => {
    await writeFile(join(corpus, 'REF-02-paper.md'), '# Paper');
    expect(await service.validateCitation('REF-2')).toBe(false);
    expect(await service.validateCitation('REF-02')).toBe(true);
  });

  it('keeps the letter suffix as part of the identity', async () => {
    await writeFile(join(corpus, 'REF-020a-paper.md'), '# Paper');
    expect(await service.validateCitation('REF-020')).toBe(false);
    expect(await service.validateCitation('REF-020a')).toBe(true);
  });

  it.each(['', ' ', '\t\n', 'REF-', 'REF-020-paper', 'REF-020aa', 'ref-020', ' REF-020', 'REF-020\n'])
  ('rejects blank or malformed ID %j even if a filename starts with it', async ref => {
    await writeFile(join(corpus, `${ref}-paper.md`), '# Invalid identity');
    expect(await service.validateCitation(ref)).toBe(false);
  });

  it('ignores a directory whose name looks like a REF file', async () => {
    await mkdir(join(corpus, 'REF-020-paper.md'));
    expect(await service.validateCitation('REF-020')).toBe(false);
  });

  it('accepts bare Markdown names and a corpus path override', async () => {
    await writeFile(join(corpus, 'REF-020.md'), '# Paper');
    expect(await new CitationService({ corpusPath: join(corpus, 'missing') })
      .validateCitation('REF-020', corpus)).toBe(true);
  });

  it('ignores other extensions and malformed filename tokens', async () => {
    await writeFile(join(corpus, 'REF-020-paper.pdf'), 'PDF');
    await writeFile(join(corpus, 'REF-020aa-paper.md'), '# Invalid');
    expect(await service.validateCitation('REF-020')).toBe(false);
  });

  it('returns false for a missing corpus', async () => {
    expect(await service.validateCitation('REF-020', join(corpus, 'missing'))).toBe(false);
  });
});
