import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assessPromotionPolicyConfiguration,
  evaluateReleasePromotion,
  loadCanonicalPromotionPolicy,
  localRegistryIdentity,
  PROMOTION_DECISION_SCHEMA,
  PROMOTION_POLICY,
  publishReleasePromotion,
  verifyPromotionPolicyCommitBinding,
  verifyRegistryPackageIdentity,
} from '../../../tools/release/release-promotion.mjs';
import {
  assertProductionReleaseEvidence,
  assertVerifiedComparisonApprovalGate,
} from '../../../tools/release/release-evidence.mjs';

const roots = [];
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-promotion-test-')); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const repoRoot = path.resolve(import.meta.dirname, '../../..');

describe('exact retained RC production promotion gate (#3201)', () => {
  it('loads the checked-in exact-RC policy and authenticated user identity', () => {
    const policy = loadCanonicalPromotionPolicy({ file: path.join(temp(), 'candidate-policy.json') });
    expect(policy.source).toBe(PROMOTION_POLICY);
    expect(policy.enabled).toBe(true);
    expect(policy.github_transport_trust).toBe('github-authenticated-user-api');
    expect(policy.allowed_approval_issuer_ids).toEqual([1159087]);
    expect(policy.publication.order).toEqual(['npmjs', 'gitea']);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('permits configured routine promotion without provider comparison identities', () => {
    const configured = JSON.parse(fs.readFileSync(path.join(repoRoot, PROMOTION_POLICY), 'utf8'));
    Object.assign(configured, { enabled: true, rc_workflow_id: 73,
      github_api_actor_ids: [77], github_transport_trust: 'github-authenticated-user-api',
      github_evidence_credential_kind: 'fine-grained-personal-access-token', allowed_approval_issuer_ids: [1159087] });
    expect(assessPromotionPolicyConfiguration(configured)).toEqual({ ready: true, unmet_requirements: [] });
    expect(() => assessPromotionPolicyConfiguration({ ...configured, required_validation_profile: 'quarterly-full-v1' })).toThrow();
    configured.allowed_approval_issuer_ids = [];
    expect(assessPromotionPolicyConfiguration(configured).ready).toBe(false);
  });

  it('rejects incomplete or disabled policy before credential access', () => {
    const configured = JSON.parse(fs.readFileSync(path.join(repoRoot, PROMOTION_POLICY), 'utf8'));
    expect(assessPromotionPolicyConfiguration({ ...configured, enabled: false }).ready).toBe(false);
    expect(assessPromotionPolicyConfiguration({ ...configured, github_api_actor_ids: [] }).ready).toBe(false);
    const source = fs.readFileSync(path.join(repoRoot, 'tools/release/release-promotion.mjs'), 'utf8');
    const start = source.indexOf('export async function evaluateReleasePromotion');
    expect(source.indexOf('if (activationProblems(policy).length)', start)).toBeLessThan(source.indexOf('process.env.AIWG_GITHUB_RELEASE_EVIDENCE_TOKEN', start));
  });

  it('does not accept a caller-selected policy option', () => {
    const script = path.join(repoRoot, 'tools/release/release-promotion.mjs');
    const result = spawnSync(process.execPath, [script, 'verify', '--policy', path.join(temp(), 'policy.json')], {
      cwd: repoRoot, encoding: 'utf8', timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Unknown option.*policy/i);
  });

  it('binds any enabled canonical policy to the verified signed commit before production acquisition', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'tools/release/release-promotion.mjs'), 'utf8');
    expect(source).toContain("['show', `${commit}:${PROMOTION_POLICY}`]");
    expect(source.indexOf('bindPolicyToSignedCommit(policy, tags.commit)'))
      .toBeLessThan(source.indexOf('acquireGithubProductionReleaseEvidence({'));
    expect(source).toContain('assertPolicyStillBound(policy, decision.candidate.commit)');
  });

  it.each([
    ['enabled', policy => { policy.enabled = false; }],
    ['actor', policy => { policy.github_api_actor_ids = [999]; }],
    ['issuer', policy => { policy.allowed_approval_issuer_ids = [999]; }],
  ])('rejects a dirty %s policy that differs from the committed policy', (_field, mutate) => {
    const root = temp(), file = path.join(root, PROMOTION_POLICY);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const policy = JSON.parse(fs.readFileSync(path.join(repoRoot, PROMOTION_POLICY), 'utf8'));
    fs.writeFileSync(file, JSON.stringify(policy, null, 2) + '\n');
    for (const args of [['init', '-q'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Test'],
      ['add', PROMOTION_POLICY], ['commit', '-qm', 'policy']]) {
      expect(spawnSync('git', args, { cwd: root, timeout: 10000 }).status).toBe(0);
    }
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10000 }).stdout.trim();
    const expectedSha256 = localRegistryIdentity(file).sha256;
    expect(verifyPromotionPolicyCommitBinding({ root, commit, expectedSha256 })).toEqual({ commit, sha256: expectedSha256 });
    mutate(policy); fs.writeFileSync(file, JSON.stringify(policy, null, 2) + '\n');
    expect(() => verifyPromotionPolicyCommitBinding({ root, commit, expectedSha256 })).toThrow(/differs from the signed release commit/);
  });

  it('rejects forged, serialized, and externally mutated decisions before invoking npm', async () => {
    const calls = [], receiptPath = path.join(temp(), 'publication.json');
    const forged = { schema: PROMOTION_DECISION_SCHEMA, ready_for_publication: true,
      policy: loadCanonicalPromotionPolicy(), packages: [] };
    await expect(publishReleasePromotion({ decision: forged, registryName: 'npmjs', receiptPath,
      spawn(...args) { calls.push(args); return { status: 0, stdout: '{}' }; } })).rejects.toThrow(/in-process ready promotion decision/);
    const real = loadCanonicalPromotionPolicy();
    const serialized = JSON.parse(JSON.stringify(forged));
    await expect(publishReleasePromotion({ decision: serialized, registryName: 'npmjs', receiptPath,
      spawn(...args) { calls.push(args); return { status: 0, stdout: '{}' }; } })).rejects.toThrow(/in-process ready promotion decision/);
    expect(calls).toEqual([]);
    expect(fs.existsSync(receiptPath)).toBe(false);
    expect(() => { real.enabled = false; }).toThrow();
  });

  it('does not let serialized evidence or comparison receipts become promotion authority', () => {
    const evidence = { archive: { extraction_verified: true } };
    const gate = { structural_evidence_complete: true, ready_for_publication: true };
    expect(() => assertProductionReleaseEvidence(evidence)).toThrow(/in-process production GitHub evidence/);
    expect(() => assertVerifiedComparisonApprovalGate(gate, evidence)).toThrow(/in-process verified comparison/);
  });

  it('binds registry idempotency to exact local shasum and SRI bytes', () => {
    const file = path.join(temp(), 'aiwg-2026.10.3.tgz');
    fs.writeFileSync(file, 'exact retained tarball bytes');
    const local = localRegistryIdentity(file);
    const metadata = { name: 'aiwg', version: '2026.10.3', dist: { shasum: local.shasum, integrity: local.integrity } };
    expect(verifyRegistryPackageIdentity({ file, packageName: 'aiwg', version: '2026.10.3', metadata })).toMatchObject(local);
    for (const field of ['name', 'version', 'shasum', 'integrity']) {
      const changed = structuredClone(metadata);
      if (field === 'name') changed.name = '@attacker/aiwg';
      else if (field === 'version') changed.version = '2026.10.2';
      else changed.dist[field] = field === 'shasum' ? '0'.repeat(40) : `sha512-${Buffer.alloc(64).toString('base64')}`;
      expect(() => verifyRegistryPackageIdentity({ file, packageName: 'aiwg', version: '2026.10.3', metadata: changed })).toThrow(/identity mismatch/);
    }
    fs.appendFileSync(file, 'changed');
    expect(() => verifyRegistryPackageIdentity({ file, packageName: 'aiwg', version: '2026.10.3', metadata })).toThrow(/identity mismatch/);
  });

  it('keeps exact tarball publication and conflict verification in the sole irreversible entry point', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'tools/release/release-promotion.mjs'), 'utf8');
    expect(source).toContain("['publish', file, '--ignore-scripts'");
    expect(source).toContain("conflict(output) ? 'already-published'");
    expect(source).toContain('verifyRegistryPackageIdentity');
    expect(source).toContain("if (registryName === 'gitea')");
    expect(source).toContain('assertStagedInventory(directory, decision.packages)');
    expect(source).toContain('const spawn = boundedSpawnSync, env = process.env');
    expect(source).not.toMatch(/npm\s+pack/);
  });
});
