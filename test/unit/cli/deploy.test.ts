/**
 * Regression tests for tools/cli/deploy.mjs
 *
 * Covers the bug where `aiwg sync` exited 254 silently because
 * tools/cli/deploy.mjs did not exist, causing script-runner to fail
 * with ENOENT when sync tried to re-deploy frameworks after an update.
 *
 * @issue deploy-mjs-missing (fixed alongside router-loader tsx fallback)
 */

import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DEPLOY_SCRIPT = resolve(__dirname, '../../../tools/cli/deploy.mjs');

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('../../../tools/_resolve-impl.mjs', () => ({
  importImpl: async () => ({ boundedExecFileSync: execFile }),
}));

describe('tools/cli/deploy.mjs', () => {
  it('exists at the path sync.ts expects', () => {
    // This is the exact path that sync.ts:121 passes to script-runner:
    // runner.run('tools/cli/deploy.mjs', ...)
    expect(existsSync(DEPLOY_SCRIPT)).toBe(true);
  });

  it('is a valid ES module (starts with shebang or import/export)', async () => {
    const { readFileSync } = await import('fs');
    const content = readFileSync(DEPLOY_SCRIPT, 'utf-8');
    // Must be a node-executable script
    expect(content).toMatch(/^#!\/usr\/bin\/env node/);
  });

  it('exports a runnable async function (not empty)', async () => {
    const { readFileSync } = await import('fs');
    const content = readFileSync(DEPLOY_SCRIPT, 'utf-8');
    // Should contain the deploy logic
    expect(content).toContain("['use', framework]");
    expect(content).toContain('boundedExecFileSync');
  });

  it('handles --provider flag', async () => {
    const { readFileSync } = await import('fs');
    const content = readFileSync(DEPLOY_SCRIPT, 'utf-8');
    expect(content).toContain('--provider');
  });

  it('passes framework and provider as separate arguments without executing the display command', async () => {
    const { readFileSync } = await import('fs');
    const content = readFileSync(DEPLOY_SCRIPT, 'utf-8');
    expect(content).toContain("const deployArgs = ['use', framework]");
    expect(content).toContain("if (provider) deployArgs.push('--provider', provider)");
    expect(content).toContain("boundedExecFileSync('aiwg', deployArgs, 'long', { stdio: 'inherit' })");
    expect(content).not.toContain('boundedExecSync(');
  });

  it('keeps framework and provider values literal and defaults to all', async () => {
    const { runDeploy } = await import('../../../tools/cli/deploy.mjs');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const framework = 'framework with spaces; $(touch injected)';
    const provider = "provider 'quoted'; $(touch injected)";
    await runDeploy([framework, '--provider', provider]);
    expect(execFile).toHaveBeenCalledWith('aiwg', ['use', framework, '--provider', provider], 'long', { stdio: 'inherit' });
    await runDeploy([]);
    expect(execFile).toHaveBeenLastCalledWith('aiwg', ['use', 'all'], 'long', { stdio: 'inherit' });
  });

  it('reports a failed argv launch and exits with status 1', async () => {
    const { runDeploy } = await import('../../../tools/cli/deploy.mjs');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    execFile.mockImplementation(() => { throw new Error('failed child'); });
    await expect(runDeploy(['sdlc'])).rejects.toThrow('exit');
    expect(error).toHaveBeenCalledWith("Deploy failed for 'sdlc': failed child");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
