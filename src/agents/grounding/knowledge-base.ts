/**
 * Knowledge Base — load and search domain knowledge for grounding agents
 *
 * @module agents/grounding/knowledge-base
 * @issue #184
 */

import { promises as fs } from 'fs';
import path from 'path';
import { projectAiwgPath } from '../../config/project-artifacts.js';
import type { KnowledgeBase, KnowledgeEntry, KnowledgeFragment, VerificationEvidence, VerificationResult } from './types.js';

// ============================================================================
// KnowledgeStore
// ============================================================================

export class KnowledgeStore {
  private bases: Map<string, KnowledgeBase>;
  private projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.bases = new Map();
  }

  /**
   * Load knowledge bases from .aiwg/knowledge/
   */
  async load(): Promise<void> {
    const knowledgeDir = projectAiwgPath(this.projectPath, 'knowledge');

    try {
      const domains = await fs.readdir(knowledgeDir);

      for (const domain of domains) {
        const domainPath = path.join(knowledgeDir, domain);
        const stat = await fs.stat(domainPath);
        if (!stat.isDirectory()) continue;

        const files = await fs.readdir(domainPath);
        const entries: KnowledgeEntry[] = [];

        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          try {
            const content = await fs.readFile(path.join(domainPath, file), 'utf-8');
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed.entries)) {
              entries.push(...parsed.entries);
            } else if (parsed.id) {
              entries.push(parsed);
            }
          } catch {
            // Skip malformed files
          }
        }

        if (entries.length > 0) {
          this.bases.set(domain, {
            domain,
            version: '1.0.0',
            entries,
          });
        }
      }
    } catch {
      // Knowledge directory doesn't exist yet
    }
  }

  /**
   * Add a knowledge base from a JSON file
   */
  async addFromFile(domain: string, filePath: string): Promise<number> {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    const entries: KnowledgeEntry[] = Array.isArray(parsed.entries)
      ? parsed.entries
      : Array.isArray(parsed) ? parsed : [parsed];

    const existing = this.bases.get(domain) || { domain, version: '1.0.0', entries: [] };
    existing.entries.push(...entries);
    this.bases.set(domain, existing);

    // Persist
    const domainDir = projectAiwgPath(this.projectPath, 'knowledge', domain);
    await fs.mkdir(domainDir, { recursive: true });
    const outFile = path.join(domainDir, path.basename(filePath));
    await fs.copyFile(filePath, outFile);

    return entries.length;
  }

  /**
   * Search knowledge across all domains or a specific domain
   */
  search(query: string, options?: { domain?: string; limit?: number }): KnowledgeFragment[] {
    const limit = options?.limit ?? 5;
    const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const results: KnowledgeFragment[] = [];

    const domains = options?.domain
      ? [this.bases.get(options.domain)].filter(Boolean) as KnowledgeBase[]
      : Array.from(this.bases.values());

    for (const base of domains) {
      for (const entry of base.entries) {
        const score = calculateRelevance(entry, queryTerms);
        if (score > 0) {
          results.push({
            content: entry.content,
            source: `${base.domain}/${entry.source || entry.id}`,
            relevance_score: score,
            metadata: { topic: entry.topic, id: entry.id },
          });
        }
      }
    }

    return results
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, limit);
  }

  /**
   * Verify literal support against the top three retrieved knowledge entries.
   * Only a whole-entry statement match establishes support; direct copular
   * negation vetoes it. Other wording abstains, including paraphrases and
   * multi-sentence passages. This is not a general semantic entailment judge
   * or a check that the stored knowledge is itself true.
   */
  verifyClaim(claim: string, domain?: string): VerificationResult {
    const fragments = this.search(claim, { domain, limit: 3 });

    if (fragments.length === 0) {
      return {
        claim,
        verified: false,
        confidence: 0,
        sources: [],
        evidence: [],
        correction: 'No relevant knowledge found in knowledge base',
      };
    }

    // Relevance selects candidates; only their content can establish support.
    const evidence: VerificationEvidence[] = fragments.map((fragment) => ({
      source: fragment.source,
      entry_id: fragment.metadata?.id,
      content: fragment.content,
      relation: compareStatements(claim, fragment.content),
    }));
    const contradictions = evidence.filter((item) => item.relation === 'contradicts');
    const verified = contradictions.length === 0
      && evidence.some((item) => item.relation === 'supports');

    return {
      claim,
      verified,
      confidence: verified ? 1 : 0,
      sources: fragments.map((f) => f.source),
      evidence,
      ...(!verified && {
        correction: contradictions.length > 0
          ? `Conflicting knowledge: ${contradictions.map((item) => item.content).join(' | ')}`
          : 'Relevant knowledge was retrieved, but explicit support was not established',
      }),
    };
  }

  listDomains(): string[] {
    return Array.from(this.bases.keys());
  }

  getDomainStats(): Array<{ domain: string; entries: number }> {
    return Array.from(this.bases.entries()).map(([domain, base]) => ({
      domain,
      entries: base.entries.length,
    }));
  }
}

// ============================================================================
// Helpers
// ============================================================================

function normalizeStatement(text: string): string {
  // Preserve case, numbers and internal punctuation: they can change meaning.
  return text.trim().replace(/\s+/g, ' ').replace(/\.$/, '');
}

function compareStatements(claim: string, content: string): VerificationEvidence['relation'] {
  const statement = normalizeStatement(claim);
  const evidence = normalizeStatement(content);
  if (!statement || !evidence) return 'unknown';
  // Do not extract assertions from questions, quotations or multi-sentence text.
  if ([statement, evidence].some((text) => /[?!;"“”]|\.(?:\s|$)/.test(text))) return 'unknown';
  if (statement === evidence) return 'supports';

  // A deliberately limited conflict rule: the same whole statement with a
  // single "not" following is/are/was/were. Never infer support by dropping
  // negation, and abstain on complex negation (e.g. "not only" or "not always").
  const affirmative = (text: string): string | undefined => {
    if (/[.!?;:\n]/.test(text)) return undefined;
    const match = text.match(/^(.+?\b(?:is|are|was|were)) not (.+)$/);
    if (!match || /\b(?:not|only|just|always|necessarily)\b/.test(match[2])) return undefined;
    return `${match[1]} ${match[2]}`;
  };
  if (affirmative(statement) === evidence || affirmative(evidence) === statement) {
    return 'contradicts';
  }
  return 'unknown';
}

function calculateRelevance(entry: KnowledgeEntry, queryTerms: string[]): number {
  const searchable = [
    entry.topic,
    entry.content,
    ...(entry.keywords || []),
  ].join(' ').toLowerCase();

  let matches = 0;
  for (const term of queryTerms) {
    if (searchable.includes(term)) {
      matches++;
    }
  }

  return queryTerms.length > 0 ? matches / queryTerms.length : 0;
}
