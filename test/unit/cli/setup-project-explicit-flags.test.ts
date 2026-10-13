/**
 * `aiwg setup project` does not re-ask a question whose answer was already
 * supplied by flag (#3062 review item 10), and strictly rejects a
 * value-taking flag given with no usable value (review item 11).
 *
 * The owner's rule, verbatim: "with terminal we can skip steps for any
 * params provided and only provide interaction when we are missing a
 * value."
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Interface as ReadlineInterface } from 'readline';
import {
  applyInteractivePrompts,
  buildSetupProjectPlan,
  setupHandler,
} from '../../../src/cli/handlers/setup.js';
import { getConfigPath } from '../../../src/config/aiwg-config.js';
import type { HandlerContext } from '../../../src/cli/handlers/types.js';

function makeTmpDir(name: string): string {
  const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { timeout: 60_000, cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { timeout: 60_000, cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { timeout: 60_000, cwd: dir });
  return dir;
}

/** Tracks every prompt actually shown; answers each with '' (accepting whatever default/current value the prompt offers). */
function trackingFakeRl(): { rl: ReadlineInterface; asked: string[] } {
  const asked: string[] = [];
  const emitter = new EventEmitter();
  const iface = Object.assign(emitter, {
    question: (prompt: string, cb: (answer: string) => void) => {
      asked.push(prompt);
      cb('');
    },
    close: () => {},
  });
  return { rl: iface as unknown as ReadlineInterface, asked };
}

describe('aiwg setup project — explicit flags skip their prompts (#3062)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir('aiwg-setup-explicit-flags');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('terminal + no values supplied: prompts for every field', async () => {
    const plan = await buildSetupProjectPlan({ projectDir: tmp, yes: true });
    const { rl, asked } = trackingFakeRl();

    await applyInteractivePrompts(plan, rl, undefined, { projectDir: tmp });

    expect(asked.some((p) => p.includes('Primary remote'))).toBe(true);
    expect(asked.some((p) => p.includes('Issue provider'))).toBe(true);
    expect(asked.some((p) => p.includes('Delivery mode'))).toBe(true);
    expect(asked.some((p) => p.includes('Default branch'))).toBe(true);
    expect(asked.some((p) => p.includes('Require CI green'))).toBe(true);
    expect(asked.some((p) => p.includes('Auto-close linked issues'))).toBe(true);
    expect(asked.some((p) => p.includes('Force-push policy'))).toBe(true);
    expect(asked.some((p) => p.includes('Require signed delivery commits'))).toBe(true);
    expect(asked.some((p) => p.includes('Providers ['))).toBe(true);
  });

  it('terminal + some values supplied: prompts only for the missing ones (exact set)', async () => {
    const supplied = {
      projectDir: tmp,
      primary: 'origin',
      deliveryMode: 'direct' as const,
      defaultBranch: 'main',
    };
    const plan = await buildSetupProjectPlan({ ...supplied, yes: true });
    const { rl, asked } = trackingFakeRl();

    const prompted = await applyInteractivePrompts(plan, rl, undefined, supplied);

    // Supplied fields are never asked about.
    expect(asked.some((p) => p.includes('Primary remote'))).toBe(false);
    expect(asked.some((p) => p.includes('Delivery mode'))).toBe(false);
    expect(asked.some((p) => p.includes('Default branch'))).toBe(false);
    // Everything else not supplied is still asked.
    expect(asked.some((p) => p.includes('Issue provider'))).toBe(true);
    expect(asked.some((p) => p.includes('Require CI green'))).toBe(true);
    expect(asked.some((p) => p.includes('Auto-close linked issues'))).toBe(true);
    expect(asked.some((p) => p.includes('Force-push policy'))).toBe(true);
    expect(asked.some((p) => p.includes('Require signed delivery commits'))).toBe(true);
    expect(asked.some((p) => p.includes('Providers ['))).toBe(true);
    // The supplied values pass through unchanged into the result.
    expect(prompted.primary).toBe('origin');
    expect(prompted.deliveryMode).toBe('direct');
    expect(prompted.defaultBranch).toBe('main');
  });

  it('terminal + every value supplied: no prompt at all', async () => {
    const supplied = {
      projectDir: tmp,
      primary: 'origin',
      issueProvider: 'local' as const,
      issueTracker: 'local',
      ci: 'origin',
      deliveryMode: 'direct' as const,
      defaultBranch: 'main',
      requireCiGreen: true,
      autoCloseIssues: true,
      forcePushPolicy: 'never' as const,
      requireSignedCommits: false,
      providers: ['claude'],
      // Also already answered — otherwise whether it's asked depends on
      // how many worker CLIs happen to be installed on the host running
      // this test, which this test does not want to depend on.
      workerDispatchChoice: 'decline' as const,
    };
    const plan = await buildSetupProjectPlan({ ...supplied, yes: true });
    const { rl, asked } = trackingFakeRl();

    await applyInteractivePrompts(plan, rl, undefined, supplied);

    expect(asked).toEqual([]);
  });

  it('flag present without a value is a usage error before any git/file work, via the real CLI parser', async () => {
    const ctx: HandlerContext = {
      args: ['project', '--yes', '--primary'],
      rawArgs: ['setup', 'project', '--yes', '--primary'],
      cwd: tmp,
      frameworkRoot: tmp,
    } as HandlerContext;

    await expect(setupHandler.execute(ctx)).rejects.toMatchObject({
      code: 'ERR_USAGE_MISSING_FLAG_VALUE',
    });
    expect(() => readFileSync(getConfigPath(tmp), 'utf-8')).toThrow();
  });

  it('--delivery-mode with no following value is a usage error naming the flag', async () => {
    const ctx: HandlerContext = {
      args: ['project', '--yes', '--delivery-mode'],
      rawArgs: ['setup', 'project', '--yes', '--delivery-mode'],
      cwd: tmp,
      frameworkRoot: tmp,
    } as HandlerContext;

    await expect(setupHandler.execute(ctx)).rejects.toMatchObject({
      code: 'ERR_USAGE_MISSING_FLAG_VALUE',
      message: expect.stringContaining('--delivery-mode'),
    });
  });
});
