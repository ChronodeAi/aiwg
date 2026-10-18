/**
 * `aiwg setup project` refuses a confirmation-impossible write before any
 * child process runs (#3062 second review, finding 6). The pre-existing
 * behavior built the whole plan — four `git` calls inside
 * `buildSetupProjectPlan()` — and only refused afterward.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { boundedSpawnSyncCalls } = vi.hoisted(() => ({ boundedSpawnSyncCalls: [] as unknown[][] }));

vi.mock('../../../src/process/bounded-child-process.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/process/bounded-child-process.mjs')>();
  return {
    ...actual,
    boundedSpawnSync: (...callArgs: unknown[]) => {
      boundedSpawnSyncCalls.push(callArgs);
      return (actual.boundedSpawnSync as (...a: unknown[]) => unknown)(...callArgs);
    },
  };
});

import { setupHandler } from '../../../src/cli/handlers/setup.js';
import type { HandlerContext } from '../../../src/cli/handlers/types.js';

describe('aiwg setup project refuses before any spawn (#3062 second review, finding 6)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aiwg-setup-refuse-before-spawn-'));
    boundedSpawnSyncCalls.length = 0;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('without --yes and without a terminal, refuses before building the plan — zero git calls', async () => {
    // No `git init` here on purpose: if the refusal did not come first, the
    // very first `git` call inside `buildSetupProjectPlan()` would itself
    // fail loudly in a non-repo directory, masking the ordering bug this
    // test exists to catch.
    mkdirSync(join(tmp, 'not-a-git-repo'), { recursive: true });
    const ctx: HandlerContext = {
      args: ['project'],
      rawArgs: ['setup', 'project'],
      cwd: join(tmp, 'not-a-git-repo'),
      frameworkRoot: tmp,
    } as HandlerContext;

    await expect(setupHandler.execute(ctx)).rejects.toMatchObject({
      code: 'ERR_NON_INTERACTIVE_CONFIRMATION_REQUIRED',
    });
    expect(boundedSpawnSyncCalls).toHaveLength(0);
  });

  it('--dry-run is unaffected: it still builds and prints the plan without the --yes/terminal refusal', async () => {
    mkdirSync(join(tmp, 'not-a-git-repo'), { recursive: true });
    const ctx: HandlerContext = {
      args: ['project', '--dry-run'],
      rawArgs: ['setup', 'project', '--dry-run'],
      cwd: join(tmp, 'not-a-git-repo'),
      frameworkRoot: tmp,
    } as HandlerContext;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await setupHandler.execute(ctx);
      expect(result.exitCode).toBe(0);
      expect(boundedSpawnSyncCalls.length).toBeGreaterThan(0);
    } finally {
      logSpy.mockRestore();
    }
  });
});
