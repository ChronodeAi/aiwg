/**
 * #245 — Memory reference helper (proposals only; no secret scrape).
 *
 * Proposes short operator-approved reference/summary strings (paths, issue
 * URLs, `aiwg show` pointers) for paste. Never writes memory stores. Never
 * scrapes clipboard, cookies, tokens, or full artifact bodies.
 *
 * Addresses #245
 */

import { getGrokbotNativeEvidence } from './evidence.js';
import { isGrokbotNativeSurfaceEnabled } from './flags.js';
import type { GrokbotNativeResultBase, GrokbotNativeRunOptions } from './types.js';

/** Operator-supplied reference seeds (never scraped from secrets surfaces). */
export interface MemoryReferenceInput {
  /** Workspace or artifact paths (short). */
  paths?: readonly string[];
  /** Issue / PR / doc URLs. */
  issueUrls?: readonly string[];
  /** `aiwg show …` style discovery pointers. */
  aiwgShowPointers?: readonly string[];
  /** Optional one-line operator summaries (not full bodies). */
  summaries?: readonly string[];
}

export interface MemoryReferenceProposal {
  /** Short paste-ready reference line. */
  text: string;
  kind: 'path' | 'issue-url' | 'aiwg-show' | 'summary';
}

export interface MemoryReferenceHelperResult extends GrokbotNativeResultBase {
  surface: 'memory-reference-helper';
  /** Present only when status is `proposed` (enabled + inputs sanitize clean). */
  proposals?: readonly MemoryReferenceProposal[];
}

/** Patterns that indicate secret scrape / credential content — reject. */
const SECRETISH = [
  /clipboard/i,
  /cookie/i,
  /\bauthorization\b/i,
  /\bbearer\s+[a-z0-9._\-+=\/]+/i,
  /\b(api[_-]?key|token|secret|password|passwd|private[_-]?key)\s*[:=]/i,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./, // JWT-ish
];

const MAX_REF_LEN = 240;

function looksSecretish(value: string): boolean {
  return SECRETISH.some((re) => re.test(value));
}

function sanitizeRef(raw: string, kind: MemoryReferenceProposal['kind']): MemoryReferenceProposal | null {
  const text = raw.trim().replace(/\s+/g, ' ');
  if (!text || text.length > MAX_REF_LEN) return null;
  if (looksSecretish(text)) return null;
  // Reject multi-paragraph / full-body dumps.
  if (text.includes('\n') || text.includes('\r')) return null;
  return { text, kind };
}

/**
 * Build operator-facing reference proposals. Default-off → `disabled`.
 * When enabled without a memory write contract, still only returns proposals
 * (status `proposed`) — never writes a memory store. Empty/unsafe inputs
 * fail closed as `blocked` with no proposals.
 */
export function memoryReferenceHelper(
  input: MemoryReferenceInput = {},
  options: GrokbotNativeRunOptions = {},
): MemoryReferenceHelperResult {
  const env = options.env ?? process.env;
  const evidence = getGrokbotNativeEvidence('memory-reference-helper');
  const enabled = isGrokbotNativeSurfaceEnabled('memory-reference-helper', env);

  if (!enabled) {
    return {
      surface: 'memory-reference-helper',
      status: 'disabled',
      enabled: false,
      wrote: false,
      message:
        'Memory reference helper is disabled (default). Set AIWG_GROKBOT_NATIVE_MEMORY_REF=1 to opt in for paste-ready reference proposals only.',
      evidence,
      remediation: 'Never scrapes clipboard/cookies/tokens; never writes Grok Bot memory.',
    };
  }

  // Product memory write API is still missing — we only propose references.
  if (evidence.importContractAvailable) {
    // Reserved: when a write contract exists, still require explicit confirmation.
    // Scaffolding never takes this branch (importContractAvailable is false).
    return {
      surface: 'memory-reference-helper',
      status: 'unavailable',
      enabled: true,
      wrote: false,
      message: 'Memory write contract flagged available but live adapter is not implemented.',
      evidence,
    };
  }

  const proposals: MemoryReferenceProposal[] = [];
  for (const p of input.paths ?? []) {
    const item = sanitizeRef(p, 'path');
    if (item) proposals.push(item);
  }
  for (const u of input.issueUrls ?? []) {
    const item = sanitizeRef(u, 'issue-url');
    if (item) proposals.push(item);
  }
  for (const a of input.aiwgShowPointers ?? []) {
    const item = sanitizeRef(a, 'aiwg-show');
    if (item) proposals.push(item);
  }
  for (const s of input.summaries ?? []) {
    const item = sanitizeRef(s, 'summary');
    if (item) proposals.push(item);
  }

  if (proposals.length === 0) {
    return {
      surface: 'memory-reference-helper',
      status: 'blocked',
      enabled: true,
      wrote: false,
      message:
        'No safe reference proposals could be built (empty input or secret-like / full-body content rejected). Memory store was not written. Product memory import API remains missing.',
      evidence,
      remediation: `Provide short paths, issue URLs, or aiwg show pointers. See ${evidence.catalogPath}.`,
    };
  }

  return {
    surface: 'memory-reference-helper',
    status: 'proposed',
    enabled: true,
    wrote: false,
    message:
      'Proposed operator-approved reference/summary strings for paste only. Did not write memory; did not scrape secrets. Product memory import API remains missing.',
    evidence,
    remediation: 'Operator pastes or approves references manually in Grok Bot.',
    proposals,
  };
}
