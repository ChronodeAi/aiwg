// Built-in threat rules, profiles, and scan limits.
export const THREAT_ASSESSMENT_SCHEMA_VERSION = '1';
export const THREAT_ASSESSMENT_ENGINE_VERSION = '1.2.0';

/**
 * Hard scan bounds keep assessment work deterministic. Reaching any bound is
 * reported as an incomplete assessment and can never silently produce a
 * proceed decision in audit/enforce mode.
 */
export const THREAT_ASSESSMENT_LIMITS = Object.freeze({
  maxInputCharacters: 262_144,
  maxParts: 128,
  maxOccurrencesPerPattern: 128,
  maxFindings: 2_048,
  maxCustomRules: 64,
  maxPatternsPerRule: 32,
});

export const THREAT_SURFACES = [
  'issue-title',
  'issue-body',
  'issue-comment',
  'pull-request-title',
  'pull-request-body',
  'pull-request-diff-summary',
  'review-comment',
  'release-note',
  'handoff',
  'outbound-maintainer-comment',
];

export const SEVERITIES = ['informational', 'low', 'moderate', 'high', 'critical'];
export const ACTIONS = ['proceed', 'record', 'flag', 'require-authorization', 'reject'];

export const BUILTIN_PACK_PREFIX = 'aiwg:';

export const BUILTIN_RULES = [
  {
    id: 'claimed-authorization',
    severity: 'moderate',
    likelihood: 4,
    impact: 4,
    taxonomy: ['ASI01', 'ASI09'],
    patterns: [
      '\\b(?:i|we)\\s+(?:have\\s+)?(?:reviewed|checked|accepted|approved|authorized|authorised|signed[ -]off)(?:\\s+and)?(?:\\s+(?:approve|authorize|authorise|accept))?\\b',
      '\\b(?:i|we)\\s+(?:approve|authorize|authorise|accept|sign[ -]off)\\b',
      '\\b(?:design|plan|specification|implementation|change|handoff)\\s+(?:is|was|has been)\\s+(?:approved|authorized|authorised|accepted|signed[ -]off|cleared)\\b',
      '\\b(?:approval|authorization|authorisation|sign[ -]off)\\s+(?:is|was|has been)\\s+(?:given|granted|completed|confirmed)\\b',
      '\\b(?:approved|authorized|authorised|signed[ -]off|cleared)\\s+by\\s+[\\w@.-]+\\b',
      '\\b(?:prior|previous|earlier)\\s+(?:approval|authorization|authorisation|sign[ -]off)\\b',
    ],
  },
  {
    id: 'instruction-override',
    severity: 'high',
    likelihood: 4,
    impact: 4,
    taxonomy: ['ASI01', 'ASI09'],
    patterns: [
      '\\bignore (all )?(previous|prior|above) instructions\\b',
      '\\b(system|developer) (prompt|message|instructions?)\\b',
      '\\bdo not (tell|inform|notify) (the )?(maintainer|operator|user)\\b',
      '\\byou are now\\b',
      '\\b(?:disable|bypass|skip|turn off)\\s+(?:(?:the|all|security|safety|authorization|authentication)\\s+)*checks?\\b',
    ],
  },
  {
    id: 'sensitive-file-target',
    severity: 'moderate',
    likelihood: 3,
    impact: 4,
    taxonomy: ['ASI03', 'ASI04', 'ASI05'],
    patterns: [
      '\\b(AGENTS|CLAUDE|AIWG|WARP)\\.md\\b',
      '\\b(MCP|mcp) config\\b',
      '\\.github/workflows/|\\.gitea/workflows/|workflow[s]?\\.ya?ml',
      '\\bagent definitions?\\b',
      '\\brules/RULES-INDEX\\.md\\b',
    ],
  },
  {
    id: 'third-party-execution',
    severity: 'high',
    likelihood: 4,
    impact: 4,
    taxonomy: ['ASI02', 'ASI04', 'ASI05'],
    patterns: [
      '\\bnpx\\s+[-@\\w./]+',
      '\\bnpm\\s+(install|i|exec)\\s+[-@\\w./]+',
      '\\bpipx?\\s+install\\s+[-\\w./]+',
      '\\bcargo\\s+install\\s+[-\\w./]+',
      '\\bcurl\\b[^|\\n]*\\|\\s*(sh|bash|zsh)\\b',
      '\\bbash\\s+<\\(\\s*curl\\b',
      '\\bgit\\+https?://',
    ],
  },
  {
    id: 'floating-version',
    severity: 'moderate',
    likelihood: 3,
    impact: 3,
    taxonomy: ['ASI04'],
    patterns: [
      '@latest\\b',
      'uses:\\s*[-\\w./]+@(main|master|latest|v?\\d+)\\b',
      'image:\\s*[-\\w./:]+:latest\\b',
      '\\b(unpinned|floating) (dependency|version|action|container)\\b',
    ],
  },
  {
    id: 'credential-or-env-probing',
    severity: 'high',
    likelihood: 4,
    impact: 5,
    taxonomy: ['ASI03', 'ASI09'],
    patterns: [
      '\\b(printenv|env\\s*\\||env\\s*$|process\\.env|os\\.environ)\\b',
      '\\.env\\b',
      '\\b(api[ _-]?keys?|secrets?|cookies?|document\\.cookie|credentials?|authentication material)\\b',
      '\\b(?:api|access|auth(?:entication)?|bearer|session|refresh|oauth|jwt|signing|github|gitea|cloud)(?:[_-]?\\s*)tokens?\\b',
      '\\b(id_rsa|ssh keys?|gpg keys?|aws_access_key|cloud credentials?)\\b',
      '\\b(?:env(?:ironment)?[ _-]?(?:vars?|variables?)|auth(?:entication)? files?)\\b',
      '\\.codex/auth\\.json\\b',
      '\\b(?:read|print|dump|echo|cat|show|reveal|disclose|send|upload|post|export)\\s+(?:(?:the|an?|all|my|your)\\s+)?tokens?\\b',
    ],
  },
  {
    id: 'pressure-without-evidence',
    severity: 'low',
    likelihood: 2,
    impact: 2,
    taxonomy: ['ASI09'],
    patterns: [
      '\\b(blocking release|urgent|must be done|priority:\\s*high|critical security|do this now)\\b',
      '\\bsecurity critical\\b',
    ],
  },
  {
    id: 'unverifiable-authority-claim',
    severity: 'low',
    likelihood: 2,
    impact: 3,
    taxonomy: ['ASI01', 'ASI09'],
    patterns: [
      '\\bP-\\d{4}-\\d{3,}\\b',
      '\\bpolicy\\s+[A-Z]-?\\d{3,}\\b',
      '\\bhex\\s+[0-9a-f]{6,12}\\b',
      '\\bCVE-\\d{4}-\\d{4,}\\b(?![\\s\\S]{0,160}https?://)',
      '\\b(advisory|standard|RFC)\\b(?![\\s\\S]{0,160}https?://)',
    ],
  },
  {
    id: 'security-framing-conflict',
    severity: 'moderate',
    likelihood: 3,
    impact: 4,
    taxonomy: ['ASI04', 'ASI09'],
    patterns: [
      '\\b(improve|fix|harden|secure|audit).{0,120}\\b(npx\\b|@latest\\b|curl\\b[^|\\n]*\\||printenv|\\.env)\\b',
      '\\b(security|secure).{0,120}\\b(add|install|run).{0,80}\\b(latest|remote|third[- ]party)\\b',
    ],
  },
];

export const BUILTIN_PACKS = Object.freeze({
  'aiwg:prompt-injection': ['instruction-override', 'pressure-without-evidence', 'unverifiable-authority-claim'],
  'aiwg:supply-chain': ['sensitive-file-target', 'third-party-execution', 'floating-version', 'security-framing-conflict'],
  'aiwg:credential-protection': ['credential-or-env-probing'],
  'aiwg:all': BUILTIN_RULES.map(rule => rule.id),
});

export const BUILTIN_PROFILES = Object.freeze({
  trusted: {
    version: '1.0.0',
    mode: 'off',
    description: 'Explicitly disables the AIWG classifier. Independent provider/platform safeguards remain active.',
    ruleSets: [],
    thresholds: { requireAuthorization: 'critical', reject: 'critical' },
  },
  audit: {
    version: '1.0.0',
    mode: 'audit',
    description: 'Records balanced findings without interrupting work.',
    ruleSets: ['aiwg:all'],
    thresholds: { flag: 'moderate', requireAuthorization: 'high', reject: 'critical' },
  },
  balanced: {
    version: '1.0.0',
    mode: 'enforce',
    description: 'Backward-compatible default with contextual false-positive suppression.',
    ruleSets: ['aiwg:all'],
    thresholds: { flag: 'moderate', requireAuthorization: 'high', reject: 'critical' },
  },
  strict: {
    version: '1.0.0',
    mode: 'enforce',
    description: 'Requires authorization at moderate severity and rejects critical findings.',
    ruleSets: ['aiwg:all'],
    thresholds: { flag: 'low', requireAuthorization: 'moderate', reject: 'critical' },
  },
  'high-assurance': {
    version: '1.0.0',
    mode: 'enforce',
    description: 'Rejects high/critical findings and requires authorization at moderate severity.',
    ruleSets: ['aiwg:all'],
    thresholds: { flag: 'low', requireAuthorization: 'moderate', reject: 'high' },
  },
});

