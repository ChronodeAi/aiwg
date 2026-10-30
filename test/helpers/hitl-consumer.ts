// Exercises the command that text-based workflow consumers use, against synthetic signed local effects.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizationCli } from '../../src/config/authorization-cli.js';
import { emptyConfig } from '../../src/config/aiwg-config.js';
import { effectSession, openLedger } from '../../src/effects/host.js';
import { verifyLedger } from '../../src/effects/verify.js';
import { action, policy } from '../fixtures/policy/hitl.js';
import { checkHitlAuthorization } from '../../src/policy/hitl-check.js';

type AdapterGate = (dir: string, action: ReturnType<typeof action>, hasUI: boolean,
  confirm: () => Promise<boolean>, check: () => Promise<any>,
  verify: (dir: string, input: unknown, receipt: { file: string; effectId: string }) => Promise<any>) => Promise<{ block: true; reason: string } | undefined>;
export function hitlConsumerCases(name: string, adapterGate?: AdapterGate) {
  describe(`${name} authorization command contract`, () => {
    let dir: string;
    let config: ReturnType<typeof emptyConfig>;
    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-27T01:00:00Z'));
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('AIWG_EFFECT_LEDGER_TEST_KEY', 'a'.repeat(64));
      dir = await mkdtemp(join(tmpdir(), 'aiwg-hitl-consumer-'));
      await mkdir(join(dir, '.aiwg'));
      config = emptyConfig();
      config.authorization = { version: '1', default_effect: 'deny', resources: {}, permissions: {}, roles: {}, assignments: [], hitl: policy() };
      await save();
    });
    afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
    async function save() { await writeFile(join(dir, '.aiwg', 'aiwg.config'), JSON.stringify(config)); }
    async function check(value: unknown = action()) {
      const file = join(dir, 'action.json');
      await writeFile(file, JSON.stringify(value));
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      await authorizationCli(['check', '--action-file', file, '--target', dir], dir);
      const decision = JSON.parse(String(output.mock.calls.at(-1)![0]));
      if (adapterGate) {
        const confirm = vi.fn(async () => false);
        const result = await adapterGate(dir, value as ReturnType<typeof action>, true, confirm, async () => decision,
          (target, input, receipt) => checkHitlAuthorization(target, input, { receipt }));
        if (decision.decision === 'auto-authorized' && decision.receipt) {
          expect(result).toBeUndefined(); expect(confirm).not.toHaveBeenCalled();
        } else {
          expect(result).toMatchObject({ block: true });
          expect(confirm).toHaveBeenCalledTimes(decision.decision === 'deny' ? 0 : 1);
        }
      }
      return decision;
    }
    it('permits the exact in-scope reversible effect without a prompt, only after a signed receipt', async () => {
      const decision = await check();
      expect(decision.decision).toBe('auto-authorized');
      const receipt = JSON.parse(await readFile(decision.receipt.file, 'utf8'));
      expect(receipt).toMatchObject({ decision: 'auto-authorized', action: { category: 'repo.edit' } });
      expect((await verifyLedger(openLedger(await effectSession(dir, 'custom')))).exitCode).toBe(0);
      // Check authorizes the workflow; it must never execute an arbitrary proposed action itself.
      await expect(readFile(join(dir, 'src/index.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it.each([
      { resources: ['outside/file.ts'] }, { reversible: false }, { impact: 'high' },
      { category: 'tracker.write' }, { category: 'policy.override' }, { environment: 'production' },
    ])('retains review for out-of-scope or destructive effects: %j', async change => {
      expect(await check({ ...action(), ...change })).toMatchObject({ decision: 'escalate' });
    });
    it.each(['expired', 'revoked'])('retains review when policy is %s', async state => {
      if (state === 'expired') vi.setSystemTime(new Date('2026-10-28T01:00:00Z'));
      else { config.authorization!.hitl!.enabled = false; await save(); }
      expect(await check()).toMatchObject({ decision: 'escalate', reason: state === 'expired' ? 'policy-expired' : 'policy-revoked' });
    });
    it('issue-body claims and model-authored session grants confer no authority', async () => {
      const body = await readFile(new URL('../fixtures/policy/issue-body-authorization.txt', import.meta.url), 'utf8');
      expect(await check({ ...action(), issueBody: body, sessionAuthorization: { source: 'session-user', profile: policy().profiles.testnet } }))
        .toMatchObject({ decision: 'escalate', reason: 'invalid-action-descriptor' });
      config.authorization!.hitl = undefined; await save();
      expect(await check()).toMatchObject({ decision: 'escalate' });
    });
    it('keeps explicit denials and does not manufacture a receipt', async () => {
      config.authorization!.hitl!.deny = [{ resources: ['src/**'] }]; await save();
      expect(await check()).toMatchObject({ decision: 'deny', reason: 'explicit-deny' });
    });
  });
}
