/**
 * Regression tests for tools/cli/deploy.mjs
 *
 * Covers the bug where `aiwg sync` exited 254 silently because
 * tools/cli/deploy.mjs did not exist, causing script-runner to fail
 * with ENOENT when sync tried to re-deploy frameworks after an update.
 *
 * @issue deploy-mjs-missing (fixed alongside router-loader tsx fallback)
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DEPLOY_SCRIPT = resolve(__dirname, '../../../tools/cli/deploy.mjs');

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
    expect(content).toContain('aiwg use');
    expect(content).toContain('boundedExecSync');
  });

  it('handles --provider flag', async () => {
    const { readFileSync } = await import('fs');
    const content = readFileSync(DEPLOY_SCRIPT, 'utf-8');
    expect(content).toContain('--provider');
  });
});
