#!/usr/bin/env node
/**
 * Bibliography resolver — establish what a paper actually cites.
 *
 * The shipped `.bib` is the author's library, not the paper's reference list. An
 * entry present in `.bib` and absent from the compiled bibliography is not a
 * citation, and asserting it fabricates a graph edge. Summing `.bib` and `.bbl`
 * without dedup inflates counts. This resolves membership from the authoritative
 * artifact and reports what it rejected and why (#2525).
 *
 * Ground-truth hierarchy, in order of preference:
 *   1. `.bbl`                          — `\bibitem` (natbib/ACM) or `\entry{` (biblatex)
 *   2. inline `\begin{thebibliography}` in a `.tex`
 *   3. `\cite`d keys resolved against the shipped `.bib`
 *      This level is not in the original hierarchy but is what BibTeX itself
 *      would print: with a `.tex` + `.bib` and no compiled output, the cited
 *      keys ARE the reference list. Without it an 80,558-entry `anthology.bib`
 *      has no safe answer. Observed in a real corpus: one paper shipped 80,568
 *      `.bib` entries and cited 6 works.
 *   4. `.bib` alone                    — refused. Metadata enrichment only.
 *
 * Usage:
 *   node tools/research/bibliography-resolver.mjs <source-dir> [--json] [--index <file>]
 *
 *   --json           machine-readable output
 *   --index <file>   newline-delimited `REF-NNN<TAB>title<TAB>arxivId` for corpus
 *                    resolution; titles are matched after brace/case normalisation
 */

import fs from 'fs';
import path from 'path';

/** Above this many `.bib`-only entries, the library is bulk, not curated. */
const BULK_LIBRARY_THRESHOLD = 200;

/** Strip TeX brace-escaping and accents so `{Prompt}-{Driven}` matches `prompt-driven`. */
export function normalizeTitle(raw) {
  return String(raw ?? '')
    .replace(/\\[a-zA-Z]+\s*/g, ' ')
    .replace(/[{}$\\]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

/** Extract an arXiv id from free text, if one is present. */
export function extractArxivId(text) {
  const m = String(text ?? '').match(/arxiv[:\s]*((?:\d{4}\.\d{4,5})(?:v\d+)?|[a-z-]+\/\d{7})/i);
  return m ? m[1].replace(/v\d+$/, '') : null;
}

/** Entries printed by a compiled `.bbl`. Handles natbib/ACM and biblatex. */
export function parseBbl(text) {
  const entries = [];
  // ACM/natbib splits the key onto the following line: \bibitem[label]%\n  {key}
  const natbib = /\\bibitem(?:\[[^\]]*\](?:%\s*)?)?\s*\{([^}]+)\}/g;
  for (const m of text.matchAll(natbib)) entries.push({ key: m[1].trim(), raw: sliceEntry(text, m.index) });
  if (entries.length > 0) return { entries, style: 'natbib' };
  const biblatex = /\\entry\{([^}]+)\}/g;
  for (const m of text.matchAll(biblatex)) entries.push({ key: m[1].trim(), raw: sliceEntry(text, m.index) });
  return { entries, style: entries.length ? 'biblatex' : 'unknown' };
}

/** Text from one entry marker to the next, for title/arXiv extraction. */
function sliceEntry(text, start) {
  const next = text.slice(start + 1).search(/\\(?:bibitem|entry\{)/);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

/** Keys actually cited by a `.tex`, across the common citation macros. */
export function parseCiteKeys(text) {
  const keys = new Set();
  const re = /\\(?:no)?[a-zA-Z]*cite[a-zA-Z]*\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/gi;
  for (const m of text.matchAll(re)) {
    for (const k of m[1].split(',')) {
      const key = k.trim();
      if (key) keys.add(key);
    }
  }
  return keys;
}

/** Entries in a `.bib`, with enough metadata to enrich a confirmed entry. */
export function parseBib(text) {
  const out = new Map();
  const re = /@(\w+)\s*\{\s*([^,\s}]+)\s*,/g;
  for (const m of text.matchAll(re)) {
    const body = sliceBibEntry(text, m.index);
    out.set(m[2].trim(), {
      key: m[2].trim(),
      type: m[1].toLowerCase(),
      title: fieldOf(body, 'title'),
      year: fieldOf(body, 'year'),
      arxiv: extractArxivId(body),
    });
  }
  return out;
}

function sliceBibEntry(text, start) {
  const next = text.slice(start + 1).search(/^@\w+\s*\{/m);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

function fieldOf(body, field) {
  const m = body.match(new RegExp(`${field}\\s*=\\s*([{"])([\\s\\S]*?)\\1\\s*[,}\\n]`, 'i'));
  return m ? m[2].replace(/\s+/g, ' ').trim() : null;
}

/** Inline `\begin{thebibliography}` block, when no `.bbl` ships. */
export function parseInlineThebibliography(text) {
  const m = text.match(/\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}/);
  return m ? parseBbl(m[0]) : { entries: [], style: 'unknown' };
}

/** Load a `REF\ttitle\tarxiv` index for corpus resolution. */
export function loadCorpusIndex(file) {
  const byTitle = new Map();
  const byArxiv = new Map();
  if (!file || !fs.existsSync(file)) return { byTitle, byArxiv };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const [ref, title, arxiv] = line.split('\t');
    if (!ref) continue;
    if (title) byTitle.set(normalizeTitle(title), ref.trim());
    if (arxiv) byArxiv.set(arxiv.trim().replace(/v\d+$/, ''), ref.trim());
  }
  return { byTitle, byArxiv };
}

/**
 * Resolve the authoritative reference list for one e-print source directory.
 *
 * @returns {{source: string, countMethod: string, count: number, uniqueCount: number,
 *            entries: Array, rejected: Array, notes: string[]}}
 */
export function resolveBibliography(dir, { index } = {}) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const pick = (ext) => files.filter((f) => f.toLowerCase().endsWith(ext));
  const notes = [];

  const bibEntries = new Map();
  for (const f of pick('.bib')) for (const [k, v] of parseBib(read(f))) if (!bibEntries.has(k)) bibEntries.set(k, v);

  let source = null;
  let countMethod = null;
  let entries = [];

  const bbl = pick('.bbl')[0];
  if (bbl) {
    const parsed = parseBbl(read(bbl));
    if (parsed.entries.length) {
      source = 'bbl';
      countMethod = `counted \\${parsed.style === 'biblatex' ? 'entry' : 'bibitem'} in ${bbl}`;
      entries = parsed.entries;
    }
  }

  if (!entries.length) {
    for (const tex of pick('.tex')) {
      const parsed = parseInlineThebibliography(read(tex));
      if (parsed.entries.length) {
        source = 'inline-thebibliography';
        countMethod = `counted \\${parsed.style === 'biblatex' ? 'entry' : 'bibitem'} in ${tex}`;
        entries = parsed.entries;
        break;
      }
    }
  }

  if (!entries.length) {
    // No compiled output. The cited keys are what BibTeX would have printed.
    const cited = new Set();
    for (const tex of pick('.tex')) for (const k of parseCiteKeys(read(tex))) cited.add(k);
    if (cited.size) {
      source = 'cite-keys';
      countMethod = `counted distinct \\cite keys across ${pick('.tex').length} .tex file(s)`;
      entries = [...cited].map((key) => ({ key, raw: '' }));
      notes.push(
        `No compiled bibliography shipped. Membership taken from ${cited.size} cited key(s); ` +
        `the ${bibEntries.size} .bib entries are the author's library and are used only for metadata.`,
      );
    }
  }

  if (!entries.length) {
    return {
      source: null,
      countMethod: null,
      count: 0,
      uniqueCount: 0,
      entries: [],
      rejected: [],
      notes: [
        'No authoritative bibliography found. A shipped .bib alone is NOT a reference list — ' +
        'read the reference list out of the PDF text and record that as the counting method.',
      ],
    };
  }

  const { byTitle, byArxiv } = loadCorpusIndex(index);
  const seen = new Set();
  const resolved = [];
  for (const e of entries) {
    const meta = bibEntries.get(e.key) ?? {};
    const title = meta.title ?? titleFromRaw(e.raw);
    const arxiv = meta.arxiv ?? extractArxivId(e.raw);
    const norm = normalizeTitle(title);
    const ref = (arxiv && byArxiv.get(arxiv)) ?? (norm && byTitle.get(norm)) ?? null;
    const confirmedBy = arxiv && byArxiv.get(arxiv) ? 'arxiv-id'
      : norm && byTitle.get(norm) ? 'exact-title'
      : 'printed-entry';
    if (!seen.has(e.key)) { seen.add(e.key); resolved.push({ key: e.key, title, year: meta.year ?? null, arxiv, ref, confirmedBy }); }
  }

  // Anything in the library but not in the printed list is not a citation.
  const rejected = [...bibEntries.values()]
    .filter((b) => !seen.has(b.key))
    .map((b) => ({ key: b.key, title: b.title, year: b.year, reason: '.bib-only — absent from the compiled bibliography' }));

  // A .bib far larger than the printed list is a bulk bibliography rather than an
  // author library; its rejections are not individually meaningful.
  const bulkLibrary = rejected.length > BULK_LIBRARY_THRESHOLD;
  if (bulkLibrary) {
    notes.push(
      `Shipped .bib holds ${bibEntries.size} entries against ${resolved.length} printed — ` +
      'treated as a bulk bibliography. Rejections are counted, not enumerated.',
    );
  }

  return {
    source,
    countMethod,
    count: entries.length,
    uniqueCount: resolved.length,
    entries: resolved,
    rejected: bulkLibrary ? [] : rejected,
    rejectedCount: rejected.length,
    bulkLibrary,
    notes,
  };
}

/**
 * Title out of a printed entry.
 *
 * Ordered attempts, not one alternation: a regex alternation picks the leftmost
 * MATCH in the string rather than the leftmost ALTERNATIVE, so a generic
 * `\newblock` branch sitting earlier in the entry captured the macro name
 * itself ("showarticletitle{Gpt-4 technical report"). Each shape gets its own
 * pass, most specific first.
 */
function titleFromRaw(raw) {
  const text = String(raw ?? '');
  const attempts = [
    /\\showarticletitle\{([\s\S]*?)\}\s*\./,      // ACM
    /\\showarticletitle\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/,
    /\\bibinfo\{(?:booktitle|title)\}\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/,
    /\\newblock\s*\\emph\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/,
    /\\newblock\s+([^.\\\n]{8,})/,                  // plain natbib
  ];
  for (const re of attempts) {
    const m = text.match(re);
    if (m?.[1]) {
      const t = m[1].replace(/\s+/g, ' ').trim();
      if (t && !/^\\/.test(t)) return t;
    }
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const idxAt = args.indexOf('--index');
  const index = idxAt >= 0 ? args[idxAt + 1] : undefined;
  const dir = args.find((a) => !a.startsWith('--') && a !== index);
  if (!dir) {
    console.error('Usage: bibliography-resolver.mjs <source-dir> [--json] [--index <file>]');
    process.exitCode = 2;
    return;
  }

  const r = resolveBibliography(dir, { index });
  if (json) { console.log(JSON.stringify(r, null, 2)); return; }

  if (!r.source) {
    console.error(r.notes.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(`source:        ${r.source}`);
  console.log(`count:         ${r.count}${r.uniqueCount !== r.count ? ` printed, ${r.uniqueCount} unique` : ''}`);
  console.log(`count-method:  ${r.countMethod}`);
  const withRef = r.entries.filter((e) => e.ref);
  console.log(`in corpus:     ${withRef.length} of ${r.uniqueCount}`);
  for (const n of r.notes) console.log(`note:          ${n}`);
  if (withRef.length) {
    console.log('\nresolved edges:');
    for (const e of withRef) console.log(`  ${e.ref}  [${e.confirmedBy}]  ${(e.title ?? e.key).slice(0, 80)}`);
  }
  if (r.rejectedCount) {
    console.log(`\nrejected (.bib-only, NOT citations): ${r.rejectedCount}`);
    if (r.bulkLibrary) {
      // Enumerating tens of thousands of rows is noise. A library this size is a
      // bulk bibliography (e.g. the whole ACL Anthology), not a curated set of
      // near-misses worth recording individually in a sidecar.
      console.log('  (not enumerated — the shipped .bib is a bulk bibliography, not a curated library)');
    } else {
      for (const e of r.rejected.slice(0, 10)) console.log(`  ${e.key}  ${(e.title ?? '').slice(0, 70)}`);
      if (r.rejected.length > 10) console.log(`  ... and ${r.rejected.length - 10} more`);
    }
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('bibliography-resolver.mjs');
if (invokedDirectly) main();
