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
  it('loads only the checked-in disabled policy and preserves explicit identity trust holds', () => {
    const policy = loadCanonicalPromotionPolicy({ file: path.join(temp(), 'candidate-policy.json') });
    expect(policy.source).toBe(PROMOTION_POLICY);
    expect(policy.enabled).toBe(false);
    expect(policy.github_transport_trust).toBeNull();
    expect(policy.comparison.repetitions).toBe(5);
    expect(policy.comparison.mode).toBe('utc-calendar-quarter');
    expect(policy.comparison.runtime_identity).toEqual({
      allow_unattested_backend: false,
      providers: { claude: null, codex: null, hermes: null },
    });
    expect(policy.publication.order).toEqual(['npmjs', 'gitea']);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.comparison.models)).toBe(true);
    expect(policy.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('has a positive configuration path only through explicit reviewed lower-trust identity policy', () => {
    const configured = JSON.parse(fs.readFileSync(path.join(repoRoot, PROMOTION_POLICY), 'utf8'));
    Object.assign(configured, { enabled: true, rc_workflow_id: 73,
      github_api_actor_ids: [77], github_transport_trust: 'github-authenticated-user-api',
      github_evidence_credential_kind: 'fine-grained-personal-access-token' });
    Object.assign(configured.comparison, { workflow_id: 74, required_job_name: 'Retain comparisons',
      required_steps: ['Run comparisons', 'Retain comparison evidence'], seed: 'frozen-production-seed', baseline_version: '2026.10.2',
      allowed_approval_issuer_ids: [1159087] });
    configured.comparison.runtime_identity.allow_unattested_backend = true;
    for (const provider of ['claude', 'codex', 'hermes']) {
      configured.comparison.runtime_identity.providers[provider] = 'requested-cli-model';
      configured.comparison.models[provider] = { subject: `${provider}-subject-20261020`, judge: `${provider}-judge-20261020` };
    }
    configured.comparison.mode = 'per-release';
    expect(assessPromotionPolicyConfiguration(configured)).toEqual({ ready: true, unmet_requirements: [] });
    configured.comparison.mode = 'utc-calendar-quarter';
    expect(assessPromotionPolicyConfiguration(configured).unmet_requirements.join(' ')).toMatch(/Missing canonical quarterly hermes/);
    configured.comparison.mode = 'per-release';
    configured.comparison.runtime_identity.allow_unattested_backend = false;
    const held = assessPromotionPolicyConfiguration(configured);
    expect(held.ready).toBe(false);
    expect(held.unmet_requirements.join(' ')).toMatch(/backend-unattested/);
  });

  it('returns a frozen non-ready decision before token or network access while policy is disabled', async () => {
    const fetchImpl = vi.fn(() => { throw new Error('network must not run'); });
    const credentialReads = vi.fn(), originalEnv = process.env;
    process.env = new Proxy(originalEnv, { get(target, property, receiver) {
      if (property === 'AIWG_GITHUB_RELEASE_EVIDENCE_TOKEN') { credentialReads(property); throw new Error('credentials must not be read'); }
      return Reflect.get(target, property, receiver);
    } });
    let decision;
    try {
      decision = await evaluateReleasePromotion({ rcTag: 'candidate supplied', stableTag: 'candidate supplied',
        runId: 1, artifactId: 1, reportFiles: [], destination: temp(), fetchImpl });
    } finally { process.env = originalEnv; }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(credentialReads).not.toHaveBeenCalled();
    expect(decision.schema).toBe(PROMOTION_DECISION_SCHEMA);
    expect(decision.ready_for_publication).toBe(false);
    expect(decision.production_identity_authenticated).toBe(false);
    expect(decision.production_identity_policy_satisfied).toBe(false);
    expect(decision.candidate).toBeNull();
    expect(decision.packages).toEqual([]);
    expect(decision.unmet_requirements.join(' ')).toMatch(/policy is disabled/);
    expect(decision.unmet_requirements.join(' ')).toMatch(/GitHub user API transport trust level/);
    expect(decision.unmet_requirements.join(' ')).toMatch(/backend-unattested/);
    expect(decision.unmet_requirements.join(' ')).toMatch(/Missing canonical quarterly hermes/);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.unmet_requirements)).toBe(true);
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
    ['enabled', policy => { policy.enabled = true; }],
    ['actor', policy => { policy.github_api_actor_ids = [999]; }],
    ['issuer', policy => { policy.comparison.allowed_approval_issuer_ids = [999]; }],
    ['model', policy => { policy.comparison.models.codex.subject = 'changed-model'; }],
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
    const real = await evaluateReleasePromotion();
    const serialized = JSON.parse(JSON.stringify({ ...real, ready_for_publication: true }));
    await expect(publishReleasePromotion({ decision: serialized, registryName: 'npmjs', receiptPath,
      spawn(...args) { calls.push(args); return { status: 0, stdout: '{}' }; } })).rejects.toThrow(/in-process ready promotion decision/);
    expect(calls).toEqual([]);
    expect(fs.existsSync(receiptPath)).toBe(false);
    expect(() => { real.ready_for_publication = true; }).toThrow();
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
