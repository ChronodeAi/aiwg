import type { DiscoveryInventory } from '../../src/discovery/types.js';

export const INTERVIEW_TIME = '2026-10-24T12:00:00.000Z';
export function guidedInventory(root = '/example/shop'): DiscoveryInventory {
  return {
    projects: [{ root, sources: ['workspace'], vcs: 'git', layout: 'project',
      packageManifest: `${root}/package.json`, workspacePatterns: [], packageRoots: [],
      aiwg: { directory: false, configFile: null, contextFile: null }, providerFiles: [] }],
    tools: ['claude', 'codex'].map(executable => ({ executable, path: `/example/bin/${executable}`,
      installed: 'yes', configured: 'no', authenticated: 'unknown', qualified: 'unknown', version: null, evidence: [] })),
    diagnostics: [], limits: { maxDepth: 4, maxEntries: 20000, timeBudgetMs: 2000, maxFileBytes: 262144 },
    stats: { entriesInspected: 5, elapsedMs: 1, truncated: false },
  };
}
