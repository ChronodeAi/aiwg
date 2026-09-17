/**
 * Static product-evidence snapshots for each Grok Bot native surface.
 *
 * `importContractAvailable` is hard-coded false until Decision-gate criteria
 * in the evidence catalog are satisfied. Do not flip these without citing
 * public product docs (or maintainer-attested operator evidence) in the PR.
 *
 * @see docs/integrations/grokbot-native-surfaces-evidence.md
 * Addresses #241 #242 #243 #244 #245
 */

import {
  GROKBOT_NATIVE_EVIDENCE_CATALOG,
  type GrokbotNativeProductEvidence,
  type GrokbotNativeSurfaceId,
} from './types.js';

const CATALOG = GROKBOT_NATIVE_EVIDENCE_CATALOG;

export const GROKBOT_NATIVE_EVIDENCE: Record<
  GrokbotNativeSurfaceId,
  GrokbotNativeProductEvidence
> = {
  'registered-machine-health': {
    catalogPath: CATALOG,
    productDocUrls: [
      'https://docs.x.ai/grok-bot/computer-and-apps',
      'https://docs.x.ai/grok-bot/approvals-security-and-privacy',
      'https://docs.x.ai/grok-bot/settings-and-notifications',
    ],
    childIssue: 244,
    importContractAvailable: false,
    missingContractNotes: [
      'No published machine-registration API, bridge ID schema, or health probe endpoint.',
      'No documented local-agent status JSON/path for read-only polling.',
      'AIWG has no machine bridge; cloud/local computer policy is Grok-owned UI only.',
    ],
  },
  'memory-reference-helper': {
    catalogPath: CATALOG,
    productDocUrls: [
      'https://docs.x.ai/grok-bot/bots',
      'https://docs.x.ai/grok-bot/faq',
      'https://docs.x.ai/grok-bot/overview',
    ],
    childIssue: 245,
    importContractAvailable: false,
    missingContractNotes: [
      'No published memory import/export API or on-disk memory schema.',
      'No safe append-reference contract distinct from scraping secrets/sessions.',
    ],
  },
  routines: {
    catalogPath: CATALOG,
    productDocUrls: [
      'https://docs.x.ai/grok-bot/skills-routines-and-automations',
      'https://docs.x.ai/grok-bot/faq',
      'https://docs.x.ai/grok-bot/settings-and-notifications',
    ],
    childIssue: 241,
    importContractAvailable: false,
    missingContractNotes: [
      'No published import format (JSON/YAML/TOML), filesystem path, or API for routines.',
      'No documented reload/sync hook after an out-of-band write.',
      'No idempotent upsert / ownership marker contract for AIWG-managed entries.',
    ],
  },
  'create-agent': {
    catalogPath: CATALOG,
    productDocUrls: [
      'https://docs.x.ai/grok-bot/bots',
      'https://docs.x.ai/grok-bot/overview',
      'https://docs.x.ai/grok-bot/chat-and-collaboration',
    ],
    childIssue: 242,
    importContractAvailable: false,
    missingContractNotes: [
      'No stable CreateAgent / profile API or import schema.',
      'No documented on-disk profile path AIWG may write.',
      'No reload contract after external profile mutation.',
    ],
  },
  'connector-install-profile': {
    catalogPath: CATALOG,
    productDocUrls: [
      'https://docs.x.ai/grok-bot/computer-and-apps',
      'https://docs.x.ai/grok-bot/skills-routines-and-automations',
      'https://docs.x.ai/grok-bot/overview',
    ],
    childIssue: 243,
    importContractAvailable: false,
    missingContractNotes: [
      'No published MCP/connector config file format, install API, or reload procedure.',
      'No documented way to register an AIWG MCP sidecar as a Plugin without operator UI.',
      'AIWG must not write connector credentials or plugin state.',
    ],
  },
};

export function getGrokbotNativeEvidence(
  surface: GrokbotNativeSurfaceId,
): GrokbotNativeProductEvidence {
  return GROKBOT_NATIVE_EVIDENCE[surface];
}
