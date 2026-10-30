// Covers path containment, protected effects, platform precedence and fail-closed receipt consumption.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyConfig } from '../../../src/config/aiwg-config.js';
import { canonicalHitlAction, checkHitlAuthorization } from '../../../src/policy/hitl-check.js';
import * as receipts from '../../../src/policy/hitl-receipt.js';
import { action, policy } from '../../fixtures/policy/hitl.js';

describe('HITL consumer check', () => {
  let dir: string;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-27T01:00:00Z'));
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AIWG_EFFECT_LEDGER_TEST_KEY', 'a'.repeat(64));
    dir = await mkdtemp(join(tmpdir(), 'aiwg-hitl-check-'));
    await mkdir(join(dir, '.aiwg'));
    const config = emptyConfig();
    config.authorization = { version: '1', default_effect: 'deny', resources: {}, permissions: {}, roles: {}, assignments: [], hitl: policy() };
    await writeFile(join(dir, '.aiwg', 'aiwg.config'), JSON.stringify(config));
  });
  afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
  it('canonicalizes aliases and new leaves before matching all resources', async () => {
    await mkdir(join(dir, 'src'));
    await symlink(join(dir, 'src'), join(dir, 'alias'), 'dir');
    const checked = await checkHitlAuthorization(dir, { ...action(), resources: ['alias/new.ts'] });
    expect(checked).toMatchObject({ decision: 'auto-authorized', receipt: { effectId: expect.any(String) } });
    expect(await canonicalHitlAction(dir, { ...action(), resources: ['alias/new.ts', 'src/new.ts'] }))
      .toMatchObject({ resources: ['src/new.ts'] });
  });
  it('rejects escapes, dangling links and malformed descriptors', async () => {
    await symlink(tmpdir(), join(dir, 'escape'), 'dir');
    await symlink(join(dir, 'absent'), join(dir, 'dangling'));
    for (const resources of [['escape/outside.ts'], ['dangling'], ['../outside'], ['/absolute'], ['src/*']]) {
      expect(await checkHitlAuthorization(dir, { ...action(), resources })).toMatchObject({ decision: 'escalate' });
    }
  });
  it.each(['.aiwg/aiwg.config', 'AGENTS.md', 'src/rules/authorization.md', '.env'])
  ('does not relabel protected %s as an ordinary edit, even through an alias', async path => {
    await mkdir(join(dir, 'src'));
    await symlink(join(dir, path), join(dir, 'src', 'alias'));
    expect(await checkHitlAuthorization(dir, { ...action(), resources: [path] })).toMatchObject({ decision: 'escalate' });
    expect(await checkHitlAuthorization(dir, { ...action(), resources: ['src/alias'] })).toMatchObject({ decision: 'escalate' });
  });
  it.each(['deny', 'escalate'] as const)('keeps the platform %s regardless of project grants', async platform => {
    expect(await checkHitlAuthorization(dir, action(), { platform })).toMatchObject({ decision: platform, reason: 'platform-constraint' });
  });
  it('does not consume a stale preview and does not use a preview as a receipt', async () => {
    expect(await checkHitlAuthorization(dir, action(), { expectedPolicyVersion: 'sha256:obsolete' }))
      .toMatchObject({ decision: 'escalate', reason: 'stale-policy-version' });
    const before = await readFile(join(dir, '.aiwg', 'aiwg.config'), 'utf8');
    vi.spyOn(receipts, 'recordHitlAuthorization').mockRejectedValue(new Error('synthetic signing failure'));
    expect(await checkHitlAuthorization(dir, action())).toMatchObject({ decision: 'escalate', reason: 'authorization-check-unavailable' });
    expect(await readFile(join(dir, '.aiwg', 'aiwg.config'), 'utf8')).toBe(before);
  });
  it('does not consume an unreconciled or revoked receipt decision', async () => {
    vi.spyOn(receipts, 'recordHitlAuthorization').mockResolvedValue({
      resolution: { decision: 'auto-authorized' }, reconciled: { result: { verification: { result: 'unknown' } } },
    } as never);
    expect(await checkHitlAuthorization(dir, action())).toMatchObject({ decision: 'escalate' });
    vi.mocked(receipts.recordHitlAuthorization).mockResolvedValue({ resolution: { decision: 'deny', reason: 'explicit-deny' } } as never);
    expect(await checkHitlAuthorization(dir, action())).toMatchObject({ decision: 'deny' });
  });
});
