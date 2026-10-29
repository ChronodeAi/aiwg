// Reuse the corpus readers to locate identities in reference and citation frontmatter.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCorpus, parseFrontmatter } from '../corpus-views/ref-parser.js';
import { identityKeys, parseResearchIdentifier } from '../../research/identity.js';
import type { ResearchPaper } from '../../research/types.js';

export interface CorpusIdentityMatch { ref: string; matched_by: string[] }

export interface CorpusIdentityRecord {
  ref: string;
  path: string;
  fields: Record<string, unknown>[];
  keys: Set<string>;
}

/** Build once for expansion; resolve retains the same ID/title matching contract. */
export function loadCorpusIdentities(root: string): CorpusIdentityRecord[] {
  return loadCorpus(root).records.map(record => {
    const keys = new Set(identityKeys({ title: record.title }));
    const fields: Record<string, unknown>[] = [];
    let bodyArxiv: string | undefined;
    for (const file of [record.path, join(root, 'documentation', 'citations', `${record.refId}-citations.md`)]) {
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      const fm = parseFrontmatter(text);
      fields.push(fm);
      for (const key of identityKeys(fm)) keys.add(key);
      for (const url of text.match(/https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf|html)\/[^\s<>\]\)]+/gi) ?? []) {
        const id = parseResearchIdentifier(url);
        if (id?.kind === 'arxiv') { bodyArxiv ??= id.id; break; }
      }
    }
    // Other body links may cite unheld papers; only a missing primary ID needs this fallback.
    if (bodyArxiv && ![...keys].some(key => key.startsWith('arxivId:') || key.startsWith('doi:'))) keys.add(`arxivId:${bodyArxiv}`);
    return { ref: record.refId, path: record.path, fields, keys };
  });
}

export function findInCorpus(root: string, paper: ResearchPaper, index = loadCorpusIdentities(root)): CorpusIdentityMatch[] {
  const wanted = new Set(identityKeys(paper));
  return index.flatMap(record => {
    const matched = [...record.keys].filter(key => wanted.has(key)).map(key => key.slice(0, key.indexOf(':')));
    return matched.length ? [{ ref: record.ref, matched_by: [...new Set(matched)] }] : [];
  });
}
