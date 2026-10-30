/**
 * Grounding Agent Types
 *
 * Interfaces for domain knowledge injection agents that verify claims,
 * retrieve knowledge, and ground conversations with factual context.
 *
 * @module agents/grounding/types
 * @issue #184
 * @research REF-022 AutoGen (ALFChat case study — 40% domain accuracy improvement)
 */

export interface VerificationResult {
  claim: string;
  verified: boolean;
  /** Strength of explicit support (0 or 1 for the literal checker), not retrieval relevance. */
  confidence: number;
  sources: string[];
  correction?: string;
  evidence?: VerificationEvidence[];
}

export interface VerificationEvidence {
  source: string;
  entry_id?: string;
  content: string;
  relation: 'supports' | 'contradicts' | 'unknown';
}

export interface KnowledgeFragment {
  content: string;
  source: string;
  relevance_score: number;
  metadata?: Record<string, string>;
}

export interface GroundingAgent {
  /** Domain this agent covers (security, performance, compliance, technology) */
  domain: string;

  /** Verify a claim against the knowledge base */
  verify_claim(claim: string): Promise<VerificationResult>;

  /** Retrieve relevant domain knowledge for a query */
  retrieve_knowledge(query: string, options?: { limit?: number }): Promise<KnowledgeFragment[]>;
}

export interface KnowledgeEntry {
  id: string;
  topic: string;
  content: string;
  source: string;
  keywords: string[];
  related?: string[];
}

export interface KnowledgeBase {
  domain: string;
  version: string;
  entries: KnowledgeEntry[];
}

export interface GroundingConfig {
  enabled: boolean;
  agents: Array<{
    domain: string;
    apply_to: string[];
    trigger: 'auto' | 'manual';
    knowledge_path: string;
  }>;
}
