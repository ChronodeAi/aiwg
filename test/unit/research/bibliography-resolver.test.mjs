/**
 * Bibliography resolver.
 *
 * The shipped `.bib` is the author's library, not the paper's reference list.
 * Fixtures are modelled on real corpus artifacts, including an author `.bib`
 * holding 80,568 entries for a paper that cites six works.
 *
 * @issue #2525
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveBibliography,
  normalizeTitle,
  extractArxivId,
  parseBbl,
  parseBib,
  parseCiteKeys,
  parseInlineThebibliography,
} from '../../../tools/research/bibliography-resolver.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aiwg-bib-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (name, body) => writeFileSync(join(dir, name), body);

describe('normalizeTitle', () => {
  it('defeats brace escaping, which beat naive matching in a real batch', () => {
    expect(normalizeTitle('{H}arm{B}ench: A Standardized Framework'))
      .toBe(normalizeTitle('HarmBench: A Standardized Framework'));
    expect(normalizeTitle('{Prompt}-{Driven} Agents')).toBe(normalizeTitle('Prompt-Driven Agents'));
    expect(normalizeTitle('A Strong{REJECT} for Empty Jailbreaks'))
      .toBe(normalizeTitle('A StrongREJECT for Empty Jailbreaks'));
  });

  it('is case and punctuation insensitive but not word-order insensitive', () => {
    expect(normalizeTitle('GPT-4 Technical Report')).toBe(normalizeTitle('gpt 4 technical report'));
    expect(normalizeTitle('A B')).not.toBe(normalizeTitle('B A'));
  });
});

describe('extractArxivId', () => {
  it('reads both id schemes and strips the version', () => {
    expect(extractArxivId('arXiv preprint arXiv:2303.08774')).toBe('2303.08774');
    expect(extractArxivId('arXiv:2010.10391v5 [cs.CL]')).toBe('2010.10391');
    expect(extractArxivId('arxiv cs/0701001')).toBe('cs/0701001');
    expect(extractArxivId('no identifier here')).toBeNull();
  });
});

describe('parseBbl', () => {
  it('reads ACM/natbib entries whose key sits on the next line', () => {
    // Real ACM-Reference-Format output splits `\bibitem[label]%` from `{key}`.
    const r = parseBbl([
      '\\begin{thebibliography}{76}',
      '\\bibitem[Achiam et~al\\mbox{.}(2023)]%',
      '        {gpt4techreport2023arxiv}',
      '\\newblock \\showarticletitle{Gpt-4 technical report}.',
      '\\bibitem[AI(2023a)]%',
      '        {claude2024website}',
      '\\newblock \\bibinfo{title}{Introducing the next generation of Claude}.',
      '\\end{thebibliography}',
    ].join('\n'));
    expect(r.style).toBe('natbib');
    expect(r.entries.map((e) => e.key)).toEqual(['gpt4techreport2023arxiv', 'claude2024website']);
  });

  it('reads biblatex entries', () => {
    const r = parseBbl('\\entry{smith2020}{article}{}\n\\entry{jones2021}{book}{}\n');
    expect(r.style).toBe('biblatex');
    expect(r.entries.map((e) => e.key)).toEqual(['smith2020', 'jones2021']);
  });
});

describe('parseCiteKeys', () => {
  it('collects keys across macros and multi-key citations', () => {
    const keys = parseCiteKeys([
      '\\citep{kapoor2024aiagentsmatter, styles2024workbench}',
      '\\citet{froger2025are}',
      '\\autocite[see][12]{vidgen2025apex}',
      '\\nocite{never-printed}',
    ].join('\n'));
    expect([...keys].sort()).toEqual([
      'froger2025are', 'kapoor2024aiagentsmatter', 'never-printed',
      'styles2024workbench', 'vidgen2025apex',
    ]);
  });
});

describe('resolveBibliography', () => {
  it('prefers the compiled .bbl over the shipped .bib', () => {
    write('main.bbl', '\\bibitem{a}\n\\newblock \\showarticletitle{Real One}.\n\\bibitem{b}\n\\newblock \\showarticletitle{Real Two}.\n');
    write('lib.bib', '@article{a, title={Real One}, year={2020}}\n@article{b, title={Real Two}, year={2021}}\n@article{uncited, title={Never Cited}, year={2019}}\n');

    const r = resolveBibliography(dir);
    expect(r.source).toBe('bbl');
    expect(r.count).toBe(2);
    expect(r.countMethod).toMatch(/counted \\bibitem in main\.bbl/);
    expect(r.entries.map((e) => e.key)).toEqual(['a', 'b']);
    // The uncited library entry is a rejection, not an edge.
    expect(r.rejected.map((x) => x.key)).toEqual(['uncited']);
    expect(r.rejected[0].reason).toMatch(/\.bib-only/);
  });

  it('falls back to inline thebibliography when no .bbl ships', () => {
    write('paper.tex', 'text \\begin{thebibliography}{2}\n\\bibitem{x}\n\\newblock Some Title Here\n\\end{thebibliography}');
    const r = resolveBibliography(dir);
    expect(r.source).toBe('inline-thebibliography');
    expect(r.count).toBe(1);
  });

  it('uses cited keys, never the library, when only .tex + .bib ship', () => {
    // The real case this exists for: a paper shipping the whole ACL Anthology as
    // its .bib. Using .bib as the membership set would assert 80,568 edges.
    const bulk = Array.from({ length: 300 }, (_, i) => `@article{bulk${i}, title={Bulk ${i}}, year={2020}}`).join('\n');
    write('anthology.bib', bulk);
    write('custom.bib', '@article{cited1, title={Cited One}, year={2024}}\n@article{cited2, title={Cited Two}, year={2025}}\n');
    write('paper.tex', '\\citep{cited1, cited2}\n\\bibliography{anthology,custom}\n');

    const r = resolveBibliography(dir);
    expect(r.source).toBe('cite-keys');
    expect(r.count).toBe(2);
    expect(r.entries.map((e) => e.key).sort()).toEqual(['cited1', 'cited2']);
    expect(r.countMethod).toMatch(/distinct \\cite keys/);
    // Bulk libraries are counted, not enumerated — 300 rows of noise is not a record.
    expect(r.bulkLibrary).toBe(true);
    expect(r.rejectedCount).toBe(300);
    expect(r.rejected).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/bulk bibliography/);
  });

  it('refuses to treat a .bib alone as a reference list', () => {
    write('only.bib', '@article{a, title={A}, year={2020}}\n');
    const r = resolveBibliography(dir);
    expect(r.source).toBeNull();
    expect(r.count).toBe(0);
    expect(r.notes.join(' ')).toMatch(/a shipped \.bib alone is NOT a reference list/i);
  });

  it('resolves corpus REFs by arXiv id and normalised title, recording which', () => {
    write('main.bbl', [
      '\\bibitem{a}',
      '\\newblock \\showarticletitle{Gpt-4 technical report}.',
      '\\newblock \\bibinfo{journal}{arXiv preprint arXiv:2303.08774}',
      '\\bibitem{b}',
      '\\newblock \\showarticletitle{{H}arm{B}ench: A Standardized Evaluation Framework}.',
      '\\bibitem{c}',
      '\\newblock \\showarticletitle{Not In The Corpus At All}.',
    ].join('\n'));
    writeFileSync(join(dir, 'idx.tsv'), [
      'REF-497\tGPT-4 Technical Report\t2303.08774',
      'REF-535\tHarmBench: A Standardized Evaluation Framework\t',
    ].join('\n'));

    const r = resolveBibliography(dir, { index: join(dir, 'idx.tsv') });
    const byKey = Object.fromEntries(r.entries.map((e) => [e.key, e]));
    expect(byKey.a.ref).toBe('REF-497');
    expect(byKey.a.confirmedBy).toBe('arxiv-id');
    expect(byKey.b.ref).toBe('REF-535');
    expect(byKey.b.confirmedBy).toBe('exact-title');
    expect(byKey.c.ref).toBeNull();
    expect(byKey.c.confirmedBy).toBe('printed-entry');
  });

  it('does not collapse an author-year collision onto the wrong node', () => {
    // "Zou et al. 2023" is GCG or Representation Engineering depending on the
    // printed entry. Exact-after-normalisation matching must keep them distinct;
    // fuzzy author-year resolution is what lands on the wrong node.
    write('main.bbl', [
      '\\bibitem{zou2023gcg}',
      '\\newblock \\showarticletitle{Universal and Transferable Adversarial Attacks on Aligned Language Models}.',
    ].join('\n'));
    writeFileSync(join(dir, 'idx.tsv'), [
      'REF-1018\tUniversal and Transferable Adversarial Attacks on Aligned Language Models\t',
      'REF-233\tRepresentation Engineering: A Top-Down Approach to AI Transparency\t',
    ].join('\n'));

    const r = resolveBibliography(dir, { index: join(dir, 'idx.tsv') });
    expect(r.entries[0].ref).toBe('REF-1018');
    expect(r.entries[0].ref).not.toBe('REF-233');
  });

  it('reports printed vs unique when a key repeats', () => {
    write('main.bbl', '\\bibitem{dup}\n\\newblock \\showarticletitle{One}.\n\\bibitem{dup}\n\\newblock \\showarticletitle{One}.\n\\bibitem{other}\n\\newblock \\showarticletitle{Two}.\n');
    const r = resolveBibliography(dir);
    expect(r.count).toBe(3);
    expect(r.uniqueCount).toBe(2);
  });
});
