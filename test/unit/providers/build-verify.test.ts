import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVerifyHandler } from '../../../src/cli/handlers/build-verify.js';
import { readAiwgConfig } from '../../../src/config/aiwg-config.js';
import { verifyProviderDeployment, type ProviderDeploymentVerification } from '../../../src/cli/services/deployment-verification.js';
import { listProviderDefinitions } from '../../../src/providers/provider-definitions.js';

vi.mock('../../../src/config/aiwg-config.js', () => ({ readAiwgConfig: vi.fn() }));
vi.mock('../../../src/cli/services/deployment-verification.js', () => ({ verifyProviderDeployment: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.resetAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function context(provider = 'codex') {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'build-verify-'));
  roots.push(cwd);
  return { cwd, frameworkRoot: cwd, args: ['--provider', provider], rawArgs: [] };
}
function configured(provider: string) {
  vi.mocked(readAiwgConfig).mockResolvedValue({ installed: { sdlc: { deployedTo: { [provider]: { skills: 1 } } } } } as never);
}
function result(findings: ProviderDeploymentVerification['findings'] = []) {
  vi.mocked(verifyProviderDeployment).mockResolvedValue({ verificationLevel: 'deployment', findings } as ProviderDeploymentVerification);
}
describe('provider-neutral build verification', () => {
  it.each(listProviderDefinitions().map(provider => provider.id))('uses shared deployment checks for %s', async provider => {
    configured(provider); result();
    const ctx = context(provider);
    const output = await buildVerifyHandler.execute(ctx);
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.message!)).toMatchObject({ provider, status: 'ready', verification: 'deployment' });
    expect(verifyProviderDeployment).toHaveBeenCalledWith(expect.objectContaining({ provider, requestedBundles: ['sdlc'], requireNativeInspection: true, projectRoot: ctx.cwd }));
  });
  it('rejects a missing deployment before verification', async () => {
    vi.mocked(readAiwgConfig).mockResolvedValue(null as never);
    expect((await buildVerifyHandler.execute(context())).exitCode).toBe(1);
    expect(verifyProviderDeployment).not.toHaveBeenCalled();
  });
  it.each(['unknown-provider', 'grok'])('does not silently fall back from invalid provider %s', async provider => {
    expect((await buildVerifyHandler.execute(context(provider))).exitCode).toBe(1);
    expect(verifyProviderDeployment).not.toHaveBeenCalled();
  });
  it('fails on blocking findings without dumping raw provider output', async () => {
    configured('grok-build');
    result([{ id: 'grok-inspect-failed', provider: 'grok-build', severity: 'blocking', message: 'Discovery mismatch', evidence: { stdout: 'private-config' } }]);
    const output = await buildVerifyHandler.execute(context('grok-build'));
    expect(output.exitCode).toBe(1);
    expect(output.message).not.toContain('private-config');
  });
});
