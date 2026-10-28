// Provides fixed synthetic HITL policies and actions for offline tests.
import type { HitlAction, HitlContext, HitlPolicy } from "../../../src/policy/hitl-types.js";
export const policy = (): HitlPolicy => ({
  version: '1', enabled: true, reviewedAt: '2026-10-27T00:00:00Z', maxAgeSeconds: 86400,
  expiresAt: '2026-10-28T00:00:00Z', deny: [], requireReview: [],
  profiles: { testnet: { categories: ['repo.edit', 'test.run'], repos: ['example/testnet'],
    environments: ['testnet'], resources: ['src/**', 'test/**'], reversible: true, maxImpact: 'low',
    expiresAt: '2026-10-28T00:00:00Z' } },
});
export const action = (): HitlAction => ({ category: 'repo.edit', repo: 'example/testnet', environment: 'testnet',
  resources: ['src/index.ts'], reversible: true, impact: 'low' });
export const context = (p = policy()): HitlContext => ({ now: '2026-10-27T01:00:00Z', layers: [{ source: 'project', policy: p }] });
