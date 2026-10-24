import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveDeployVersion } from '../../../src/providers/deploy-version.mjs';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function source() {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwg-deploy-version-'));
  roots.push(root);
  return root;
}
describe('deployment version boundary', () => {
  it('reads the selected corpus rather than the launcher version', () => {
    const root = source();
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2026.11.1' }));
    expect(resolveDeployVersion(root)).toBe('2026.11.1');
  });
  it('preserves explicit project-local versions and commit identities', () => {
    const root = source();
    expect(resolveDeployVersion(root, '3.2.1')).toBe('3.2.1');
    expect(resolveDeployVersion(root, '50cdf26b0')).toBe('50cdf26b0');
  });
  it.each([undefined, '{}', '{', '{"version":"unknown"}', '{"version":" "}'])('diagnoses an unresolved version: %s', pkg => {
    const root = source();
    if (pkg) writeFileSync(path.join(root, 'package.json'), pkg);
    const warn = vi.fn();
    expect(resolveDeployVersion(root, undefined, warn)).toBe('unknown');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain(path.join(root, 'package.json'));
    expect(warn.mock.calls[0][0]).toContain('managed markers will use vunknown');
  });
});
