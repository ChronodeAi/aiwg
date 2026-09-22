import { describe, expect, it } from 'vitest';

import {
  findUnboundedCalls,
  TEST_PROCESS_TIMEOUT_MS,
} from '../../../tools/testing/check-sync-child-process-timeouts.mjs';

describe('synchronous child-process timeout gate', () => {
  it('flags each synchronous API when its options omit a timeout', () => {
    const source = `
      execSync('git status', { encoding: 'utf8' });
      execFileSync('git', ['status']);
      spawnSync('git', ['status'], { stdio: 'pipe' });
    `;

    expect(findUnboundedCalls('fixture.ts', source).map(({ api }) => api)).toEqual([
      'execSync',
      'execFileSync',
      'spawnSync',
    ]);
  });

  it('accepts explicit timeouts on all synchronous APIs', () => {
    const source = `
      execSync('git status', { timeout: ${TEST_PROCESS_TIMEOUT_MS} });
      execFileSync('git', ['status'], { timeout: ${TEST_PROCESS_TIMEOUT_MS} });
      spawnSync('git', ['status'], { timeout: ${TEST_PROCESS_TIMEOUT_MS} });
    `;

    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });
});
