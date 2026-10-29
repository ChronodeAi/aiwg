// Reuse the corpus readers to locate identities in reference and citation frontmatter.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCorpus, parseFrontmatter } from '../corpus-views/ref-parser.js';
import { identityKeys } from '../../research/identity.js';
import type { ResearchPaper } from '../../research/types.js';

export interface CorpusIdentityMatch { ref: string; matched_by: string[] }

export function findInCorpus(root: string, paper: ResearchPaper): CorpusIdentityMatch[] {
  const wanted = new Set(identityKeys(paper));
  return loadCorpus(root).records.flatMap(record => {
    const keys = new Set(identityKeys({ title: record.title }));
    for (const file of [record.path, join(root, 'documentation', 'citations', `${record.refId}-citations.md`)]) {
      if (existsSync(file)) for (const key of identityKeys(parseFrontmatter(readFileSync(file, 'utf8')))) keys.add(key);
    }
    const matched = [...keys].filter(key => wanted.has(key)).map(key => key.slice(0, key.indexOf(':')));
    return matched.length ? [{ ref: record.refId, matched_by: [...new Set(matched)] }] : [];
  });
}
