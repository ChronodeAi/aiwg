// Share legacy registry aliases between update planning and config persistence.
/**
 * Maps framework registry IDs (e.g. 'sdlc-complete') to `aiwg use` names (e.g. 'sdlc').
 */
export const REGISTRY_ID_TO_USE_NAME: Record<string, string> = {
  'sdlc-complete': 'sdlc',
  'media-marketing-kit': 'marketing',
  'media-curator': 'media-curator',
  'research-complete': 'research',
  'forensics-complete': 'forensics',
};

