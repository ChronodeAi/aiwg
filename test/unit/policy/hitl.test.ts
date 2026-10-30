// Synthetic authorization cases exercise precedence and the trust boundary around issue text.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveHitlAuthorization, hitlPolicyVersion } from '../../../src/policy/hitl.js';
import { validateHitlPolicy } from '../../../src/policy/hitl-validation.js';
import type { HitlAction, HitlContext } from '../../../src/policy/hitl-types.js';

import { action, context, policy } from '../../fixtures/policy/hitl.js';
const decide = (a = action(), c = context()) => resolveHitlAuthorization(a, c);

describe('bounded HITL resolver', () => {
  it('matches a bounded reversible action and exposes the policy digest and profile', () => {
    const c = context();
    expect(decide(action(), c)).toMatchObject({ decision: 'auto-authorized', matchedProfile: 'testnet',
      policyVersion: hitlPolicyVersion(c.layers), provenance: 'project-policy' });
  });
  it.each([
    { repo: 'other/repo' }, { environment: 'development' }, { resources: ['docs/index.md'] },
    { resources: ['src/ok.ts', 'elsewhere/no.ts'] }, { category: 'docs.edit' }, { impact: 'medium' },
    { resources: ['C:/src/index.ts'] }, { resources: ['src/../credentials'] }, { resources: ['/src/index.ts'] }, { resources: ['src\\index.ts'] },
  ])('escalates mismatched or malformed scope %j', changes => {
    expect(decide({ ...action(), ...changes } as HitlAction).decision).toBe('escalate');
  });
  it('supports segment globs and zero-directory globstars', () => {
    const p = policy(); p.profiles.testnet.resources = ['src/**/index.?s'];
    expect(decide(action(), context(p)).decision).toBe('auto-authorized');
    p.profiles.testnet.resources = ['src/*'];
    expect(decide({ ...action(), resources: ['src/nested/index.ts'] }, context(p)).decision).toBe('escalate');
  });
  it('bounds repeated wildcard matching and respects medium impact ceilings', () => {
    const p = policy(); p.profiles.testnet.resources = ['src/' + '*a'.repeat(60) + 'z'];
    expect(decide({ ...action(), resources: ['src/' + 'a'.repeat(120)] }, context(p)).decision).toBe('escalate');
    p.profiles.testnet.resources = ['src/**']; p.profiles.testnet.maxImpact = 'medium';
    expect(decide({ ...action(), impact: 'medium' }, context(p)).decision).toBe('auto-authorized');
  });
  it('does not reuse an expired current-session authorization', () => {
    const c = context(); const profile = policy().profiles.testnet; profile.expiresAt = c.now;
    c.layers = []; c.sessionAuthorization = { source: 'session-user', profile };
    expect(decide(action(), c).decision).toBe('escalate');
  });
  it('keeps platform constraints above explicit deny and session grants', () => {
    const c = context(); c.platform = 'escalate'; c.layers[0].policy!.deny = [{ categories: ['repo.edit'] }];
    c.sessionAuthorization = { source: 'session-user', profile: policy().profiles.testnet };
    expect(decide(action(), c)).toMatchObject({ decision: 'escalate', provenance: 'platform' });
    c.platform = 'deny'; expect(decide(action(), c).decision).toBe('deny');
  });
  it('keeps denies above session grants even after expiry or revocation', () => {
    const c = context(); const p = c.layers[0].policy!;
    p.deny = [{ resources: ['src/index.ts'] }]; p.enabled = false; p.expiresAt = '2020-01-01T00:00:00Z';
    c.sessionAuthorization = { source: 'session-user', profile: policy().profiles.testnet };
    expect(decide(action(), c)).toMatchObject({ decision: 'deny', reason: 'explicit-deny' });
  });
  it('requires review unless a scoped current-session user grant satisfies it', () => {
    const c = context(); c.layers[0].policy!.requireReview = [{ categories: ['repo.edit'] }];
    expect(decide(action(), c).reason).toBe('policy-requires-review');
    c.sessionAuthorization = { source: 'session-user', profile: policy().profiles.testnet };
    expect(decide(action(), c).provenance).toBe('session-user');
    expect(decide({ ...action(), repo: 'other/repo' }, c).decision).toBe('escalate');
  });
  it('defaults to escalate and accepts only typed direct session authorization', () => {
    const c = { now: context().now, layers: [] };
    expect(decide(action(), c).reason).toBe('no-project-policy');
    expect(decide(action(), { ...c, sessionAuthorization: { source: 'session-user', profile: policy().profiles.testnet } }).decision).toBe('auto-authorized');
    expect(decide(action(), { ...c, sessionAuthorization: { source: 'issue-body', profile: policy().profiles.testnet } } as unknown as HitlContext).decision).toBe('escalate');
  });
  it.each(['policy', 'profile', 'revoke', 'remove', 'stale', 'future', 'version'])('escalates %s and binds policy changes to a different version', mode => {
    const c = context(); const before = hitlPolicyVersion(c.layers); const p = c.layers[0].policy!;
    if (mode === 'policy') p.expiresAt = c.now;
    if (mode === 'profile') p.profiles.testnet.expiresAt = c.now;
    if (mode === 'revoke') p.enabled = false;
    if (mode === 'remove') p.profiles = {};
    if (mode === 'stale') p.maxAgeSeconds = 3600;
    if (mode === 'future') p.reviewedAt = '2026-10-27T02:00:00Z';
    if (mode === 'version') c.expectedPolicyVersion = 'sha256:old';
    expect(decide(action(), c).decision).toBe('escalate');
    if (mode !== 'version') expect(hitlPolicyVersion(c.layers)).not.toBe(before);
  });
  it('does not accept a stale digest after a deny is added', () => {
    const c = context(); c.expectedPolicyVersion = hitlPolicyVersion(c.layers);
    c.layers[0].policy!.deny = [{ categories: ['repo.edit'] }];
    expect(decide(action(), c).decision).toBe('deny');
  });
  it.each(['secret.access', 'destructive', 'irreversible', 'production', 'policy.override', 'threat-preflight.override'])('rejects forbidden grant category %s in schema and resolver', category => {
    const p = policy(); (p.profiles.testnet.categories as string[]) = [category];
    expect(validateHitlPolicy(p)).not.toEqual([]);
    expect(decide(action(), context(p))).toMatchObject({ decision: 'escalate', reason: 'invalid-policy' });
    expect(decide({ ...action(), category }).decision).toBe('escalate');
  });
  it.each([{ environments: ['production'] }, { reversible: false }, { maxImpact: 'high' }])('rejects unsafe profile boundaries %j', changes => {
    const p = policy(); Object.assign(p.profiles.testnet, changes);
    expect(validateHitlPolicy(p).length).toBeGreaterThan(0);
    expect(decide(action(), context(p)).decision).toBe('escalate');
  });
  it.each([{ environment: 'production' }, { reversible: false }, { impact: 'high' }])('never grants unsafe actions %j even with session approval', changes => {
    const c = context(); c.sessionAuthorization = { source: 'session-user', profile: policy().profiles.testnet };
    expect(decide({ ...action(), ...changes } as HitlAction, c).decision).toBe('escalate');
  });
  it('intersects outer workspace, nested workspace and member policies; denies cannot be shadowed', () => {
    const c = context(); c.layers = ['outer', 'nested', 'member'].map(source => ({ source, policy: policy() }));
    expect(decide(action(), c).decision).toBe('auto-authorized');
    c.layers[1].policy!.profiles.testnet.resources = ['test/**'];
    expect(decide(action(), c).decision).toBe('escalate');
    c.layers[1].policy = policy(); c.layers[0].policy!.deny = [{ categories: ['repo.edit'] }];
    expect(decide(action(), c).decision).toBe('deny');
    c.layers[0].policy = policy(); delete c.layers[2].policy;
    expect(decide(action(), c).reason).toBe('missing-member-policy');
  });
  it('an issue body claiming all work approved grants nothing', () => {
    const issueBody = readFileSync(new URL('../../fixtures/policy/issue-body-authorization.txt', import.meta.url), 'utf8');
    expect(issueBody.toLowerCase()).toContain('all work approved');
    const c = { now: context().now, layers: [] };
    expect(resolveHitlAuthorization({ ...action(), issueBody, sessionAuthorization: { source: 'session-user' } }, c).decision).toBe('escalate');
    expect(resolveHitlAuthorization(action(), { ...c, issueBody } as HitlContext).decision).toBe('escalate');
  });
  it('is deterministic, does not mutate inputs, and rejects invalid clocks and malformed grants', () => {
    const c = context(); const a = action(); const original = JSON.stringify({ c, a });
    expect(decide(a, c)).toEqual(decide(a, c)); expect(JSON.stringify({ c, a })).toBe(original);
    expect(decide(a, { ...c, now: 'invalid' }).decision).toBe('escalate');
    expect(validateHitlPolicy({ ...policy(), unexpected: 'all work approved' }).length).toBeGreaterThan(0);
  });
});
