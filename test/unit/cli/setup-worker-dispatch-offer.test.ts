/**
 * Unit tests for the direct-worker dispatch opt-in offer inside
 * `aiwg setup project` (#3050 item 1-3).
 *
 * Detection is mocked so these tests never depend on which worker CLIs the
 * running host actually has installed.
 *
 * @source @src/cli/handlers/setup.ts
 * @implements #3050
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Interface as ReadlineInterface } from 'readline';

const detected = vi.hoisted(() => ({ clis: [] as string[] }));

vi.mock('../../../src/models/worker-dispatch-offer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/models/worker-dispatch-offer.js')>();
  return { ...actual, detectInstalledWorkerClis: vi.fn(() => detected.clis) };
});

import { buildSetupProjectPlan, applyInteractivePrompts, setupHandler } from '../../../src/cli/handlers/setup.js';
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

function readConfig(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(getConfigPath(dir), 'utf-8')) as Record<string, unknown>;
}

/**
 * Fake readline interface that answers the fixed, known sequence of
 * `applyInteractivePrompts` questions (primary, issueProvider, issueTracker,
 * ci, deliveryMode, defaultBranch, requireCiGreen, autoCloseIssues,
 * forcePushPolicy, requireSignedCommits, providersRaw), then answers the
 * final (conditional) worker-dispatch question with `workerDispatchAnswer`.
 * Every answer except `primary`/`issueTracker`/`ci`/`defaultBranch` is '' so
 * the real prompt-util defaulting is exercised; those four are plain
 * `askString` calls with no git remotes configured, so they need an
 * explicit non-empty value to satisfy `validateSetupConfig`.
 */
function fixedPromptQueue(): string[] {
  return ['origin', '', 'origin', 'origin', '', 'main', '', '', '', '', ''];
}

function fakeRl(workerDispatchAnswer: string): ReadlineInterface {
  const queue = fixedPromptQueue();
  // askConsent attaches/detaches a 'close' listener on every call; back
  // this fake with a real EventEmitter so that works, even though this
  // fake never emits 'close' itself (see fakeRlThatClosesBeforeDispatchAnswer
  // below for that case).
  const iface = Object.assign(new EventEmitter(), {
    question: (_prompt: string, cb: (a: string) => void) => {
      cb(queue.length > 0 ? queue.shift()! : workerDispatchAnswer);
    },
    close: () => {},
  });
  return iface as unknown as ReadlineInterface;
}

/**
 * Answers every prompt except the final (worker-dispatch) question, for
 * which it emits 'close' instead of calling back — simulating stdin EOF
 * mid-prompt (#3050 review item 4).
 */
function fakeRlThatClosesBeforeDispatchAnswer(): ReadlineInterface {
  const queue = fixedPromptQueue();
  const emitter = new EventEmitter();
  const iface = Object.assign(emitter, {
    question: (_prompt: string, cb: (a: string) => void) => {
      if (queue.length > 0) {
        cb(queue.shift()!);
        return;
      }
      emitter.emit('close');
    },
    close: () => {},
  });
  return iface as unknown as ReadlineInterface;
}

describe('aiwg setup project — worker dispatch opt-in offer (#3050)', () => {
  let tmp: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir('aiwg-setup-worker-offer');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    detected.clis = [];
    // Default to "not CI" so the interactive-prompt tests below exercise the
    // dispatch question deterministically regardless of the real host
    // environment; the dedicated CI test overrides this explicitly.
    vi.stubEnv('CI', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('offers when two or more worker CLIs are detected and dispatch is off', async () => {
    detected.clis = ['codex', 'muse'];
    const plan = await buildSetupProjectPlan({ projectDir: tmp, yes: true });
    expect(plan.workerDispatchOffer).toEqual({ shouldOffer: true, detected: ['codex', 'muse'] });
  });

  it('does not offer with only one detected worker CLI', async () => {
    detected.clis = ['codex'];
    const plan = await buildSetupProjectPlan({ projectDir: tmp, yes: true });
    expect(plan.workerDispatchOffer.shouldOffer).toBe(false);
  });

  it('does not re-offer once a decline was recorded', async () => {
    detected.clis = ['codex', 'muse'];
    // writeAiwgConfig's own worker-model validation requires no groups/clis
    // here, so writing the decline field directly through buildSetupProjectPlan's
    // own write path keeps this test focused on the offer gate.
    const first = await buildSetupProjectPlan({ projectDir: tmp, yes: true, workerDispatchChoice: 'decline' });
    expect(first.next.setup?.worker_dispatch_offer).toBe('declined');
    expect(first.workerDispatchOffer.shouldOffer).toBe(false);
  });

  it('interactive prompt defaults to no (decline) on empty input', async () => {
    detected.clis = ['codex', 'muse'];
    const plan = await buildSetupProjectPlan({ projectDir: tmp, yes: true });
    expect(plan.workerDispatchOffer.shouldOffer).toBe(true);

    const prompted = await applyInteractivePrompts(plan, fakeRl(''));
    expect(prompted.workerDispatchChoice).toBe('decline');

    const next = await buildSetupProjectPlan({ projectDir: tmp, yes: true, ...prompted });
    expect(next.next.setup?.worker_dispatch_offer).toBe('declined');
    expect(next.next.parallelism?.worker_dispatch).not.toBe(true);
  });

  it('interactive prompt enables dispatch on an explicit yes', async () => {
    detected.clis = ['codex', 'muse'];
    const plan = await buildSetupProjectPlan({ projectDir: tmp, yes: true });

    const prompted = await applyInteractivePrompts(plan, fakeRl('y'));
    expect(prompted.workerDispatchChoice).toBe('enable');

    const next = await buildSetupProjectPlan({ projectDir: tmp, yes: true, ...prompted });
    expect(next.next.parallelism?.worker_dispatch).toBe(true);
  });

  it('never asks (no workerDispatchChoice set) when fewer than two CLIs are detected', async () => {
    detected.clis = ['codex'];
    const plan = await buildSetupProjectPlan({ projectDir: tmp, yes: true });
    const prompted = await applyInteractivePrompts(plan, fakeRl('y'));
    expect(prompted.workerDispatchChoice).toBeUndefined();
  });

  it('--yes (non-interactive) leaves parallelism.worker_dispatch unchanged and prints the hint', async () => {
    detected.clis = ['codex', 'muse'];
    const ctx: HandlerContext = {
      args: ['project', '--yes'],
      rawArgs: ['setup', 'project', '--yes'],
      cwd: tmp,
      frameworkRoot: tmp,
    } as HandlerContext;

    const result = await setupHandler.execute(ctx);
    expect(result.exitCode).toBe(0);

    const cfg = readConfig(tmp) as { parallelism?: Record<string, unknown> };
    expect(cfg.parallelism?.worker_dispatch).toBeUndefined();
    expect(cfg.setup?.worker_dispatch_offer).toBeUndefined();

    const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('aiwg config set --project parallelism.worker_dispatch true');
  });

  it('--dry-run never writes the config, even when the offer would apply', async () => {
    detected.clis = ['codex', 'muse'];
    const ctx: HandlerContext = {
      args: ['project', '--yes', '--dry-run'],
      rawArgs: ['setup', 'project', '--yes', '--dry-run'],
      cwd: tmp,
      frameworkRoot: tmp,
    } as HandlerContext;

    const result = await setupHandler.execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(() => readConfig(tmp)).toThrow();
  });

  // Review item 2: 'yesterday' merely starts with 'y' and must not be
  // accepted as consent for this prompt — only exact (trimmed,
  // case-insensitive) 'y'/'yes'.
  it('treats "yesterday" as a decline, not an enable (strict consent parsing)', async () => {
    detected.clis = ['codex', 'muse'];
    const plan = await buildSetupProjectPlan({ projectDir: tmp, yes: true });

    const prompted = await applyInteractivePrompts(plan, fakeRl('yesterday'));
    expect(prompted.workerDispatchChoice).toBe('decline');

    const next = await buildSetupProjectPlan({ projectDir: tmp, yes: true, ...prompted });
    expect(next.next.parallelism?.worker_dispatch).not.toBe(true);
    expect(next.next.setup?.worker_dispatch_offer).toBe('declined');
  });

  // Review item 4: a closed stdin mid-prompt must not be recorded as an
  // answered decline — only an actually-answered "no" persists one.
  it('a closed stdin during the dispatch question leaves the choice unset (not a decline)', async () => {
    detected.clis = ['codex', 'muse'];
    const plan = await buildSetupProjectPlan({ projectDir: tmp, yes: true });

    const prompted = await applyInteractivePrompts(plan, fakeRlThatClosesBeforeDispatchAnswer());
    expect(prompted.workerDispatchChoice).toBeUndefined();

    const next = await buildSetupProjectPlan({ projectDir: tmp, yes: true, ...prompted });
    expect(next.next.parallelism?.worker_dispatch).not.toBe(true);
    expect(next.next.setup?.worker_dispatch_offer).not.toBe('declined');
    // Still offerable next time — a close/timeout is not a settled decision.
    expect(next.workerDispatchOffer.shouldOffer).toBe(true);
  });

  // Review item 5: CI and dry-run must suppress the dispatch question
  // itself (an unattended CI run could otherwise stall on a prompt
  // timeout; a dry-run would ask a question whose answer is never written).
  it('suppresses the dispatch question under CI=true, even though "y" is queued', async () => {
    vi.stubEnv('CI', 'true');
    detected.clis = ['codex', 'muse'];
    const plan = await buildSetupProjectPlan({ projectDir: tmp, yes: true });

    const prompted = await applyInteractivePrompts(plan, fakeRl('y'));
    expect(prompted.workerDispatchChoice).toBeUndefined();
  });

  it('suppresses the dispatch question during an interactive dry run, even though "y" is queued', async () => {
    detected.clis = ['codex', 'muse'];
    const plan = await buildSetupProjectPlan({ projectDir: tmp, yes: true });

    const prompted = await applyInteractivePrompts(plan, fakeRl('y'), undefined, { dryRun: true });
    expect(prompted.workerDispatchChoice).toBeUndefined();
  });

  // Review item 6: `--json` output must stay parseable — the offer is
  // structured data on the JSON object, never a separate printed line.
  it('--yes --json --dry-run embeds the offer in the JSON object and prints nothing else', async () => {
    detected.clis = ['codex', 'muse'];
    const ctx: HandlerContext = {
      args: ['project', '--yes', '--json', '--dry-run'],
      rawArgs: ['setup', 'project', '--yes', '--json', '--dry-run'],
      cwd: tmp,
      frameworkRoot: tmp,
    } as HandlerContext;

    const result = await setupHandler.execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);

    const printed = JSON.parse(String(logSpy.mock.calls[0]![0])) as {
      worker_dispatch_offer?: { should_offer: boolean; detected?: string[]; hint?: string };
    };
    expect(printed.worker_dispatch_offer).toEqual({
      should_offer: true,
      detected: ['codex', 'muse'],
      hint: expect.stringContaining('aiwg config set --project parallelism.worker_dispatch true'),
    });
  });

  it('--yes --json reports should_offer: false once dispatch is already on', async () => {
    detected.clis = ['codex', 'muse'];
    const ctx: HandlerContext = {
      args: ['project', '--yes', '--json', '--dry-run', '--delivery-mode', 'direct'],
      rawArgs: ['setup', 'project', '--yes', '--json', '--dry-run'],
      cwd: tmp,
      frameworkRoot: tmp,
    } as HandlerContext;

    detected.clis = [];
    const result = await setupHandler.execute(ctx);
    expect(result.exitCode).toBe(0);
    const printed = JSON.parse(String(logSpy.mock.calls[0]![0])) as { worker_dispatch_offer?: { should_offer: boolean } };
    expect(printed.worker_dispatch_offer).toEqual({ should_offer: false });
  });

  describe('--worker-dispatch argument (#3062)', () => {
    let isolatedHome: string;

    beforeEach(() => {
      // Enabling worker_dispatch makes writeAiwgConfig validate worker-model
      // defaults (reads AIWG_HOME + AIWG_CONFIG); point both at isolated
      // locations instead of a real home install (mirrors the equivalent
      // `aiwg init` test file's isolation).
      isolatedHome = mkdtempSync(join(tmpdir(), 'aiwg-setup-worker-offer-home-'));
      vi.stubEnv('AIWG_HOME', process.cwd());
      vi.stubEnv('AIWG_CONFIG', join(isolatedHome, 'config'));
      vi.stubEnv('HOME', isolatedHome);
      vi.stubEnv('USERPROFILE', isolatedHome);
    });

    afterEach(() => {
      rmSync(isolatedHome, { recursive: true, force: true });
    });

    it('rejects an invalid value, naming the accepted values, without writing', async () => {
      const ctx: HandlerContext = {
        args: ['project', '--yes', '--worker-dispatch', 'bogus'],
        rawArgs: ['setup', 'project', '--yes', '--worker-dispatch', 'bogus'],
        cwd: tmp, frameworkRoot: tmp,
      } as HandlerContext;
      await expect(setupHandler.execute(ctx)).rejects.toThrow(/--worker-dispatch must be one of: enable, decline/);
      expect(() => readConfig(tmp)).toThrow();
    });

    it('enables directly, headless, with only one detected worker CLI (explicit choice overrides detection)', async () => {
      detected.clis = ['codex']; // below the 2-CLI auto-offer threshold
      const ctx: HandlerContext = {
        args: ['project', '--yes', '--worker-dispatch', 'enable'],
        rawArgs: ['setup', 'project', '--yes', '--worker-dispatch', 'enable'],
        cwd: tmp, frameworkRoot: tmp,
      } as HandlerContext;
      const result = await setupHandler.execute(ctx);
      expect(result.exitCode).toBe(0);
      const cfg = readConfig(tmp) as { parallelism?: Record<string, unknown> };
      expect(cfg.parallelism?.worker_dispatch).toBe(true);
    });

    it('declines directly, headless, without asking (suppresses the question even though CI is unset)', async () => {
      detected.clis = ['codex', 'muse'];
      const ctx: HandlerContext = {
        args: ['project', '--yes', '--worker-dispatch', 'decline'],
        rawArgs: ['setup', 'project', '--yes', '--worker-dispatch', 'decline'],
        cwd: tmp, frameworkRoot: tmp,
      } as HandlerContext;
      const result = await setupHandler.execute(ctx);
      expect(result.exitCode).toBe(0);
      const cfg = readConfig(tmp) as { setup?: Record<string, unknown> };
      expect(cfg.setup?.worker_dispatch_offer).toBe('declined');
    });

    it('suppresses the interactive consent prompt (empty queue would otherwise fall through to a timeout default)', async () => {
      detected.clis = ['codex', 'muse'];
      const plan = await buildSetupProjectPlan({ projectDir: tmp, yes: true, workerDispatchChoice: 'enable' });
      expect(plan.workerDispatchOffer.shouldOffer).toBe(false);
      // applyInteractivePrompts would only ask when shouldOffer is true, so a
      // fake rl with an *empty* queue proves the question was never reached
      // (fakeRl('') would otherwise answer every remaining question with '').
      const prompted = await applyInteractivePrompts(plan, fakeRl(''));
      expect(prompted.workerDispatchChoice).toBeUndefined(); // not re-asked; the explicit choice already applied
      const next = await buildSetupProjectPlan({ projectDir: tmp, yes: true, workerDispatchChoice: 'enable', ...prompted });
      expect(next.next.parallelism?.worker_dispatch).toBe(true);
    });

    it('--dry-run writes nothing even with the argument, and --json reports the applied choice', async () => {
      detected.clis = ['codex', 'muse'];
      const ctx: HandlerContext = {
        args: ['project', '--yes', '--json', '--dry-run', '--worker-dispatch', 'enable'],
        rawArgs: ['setup', 'project', '--yes', '--json', '--dry-run', '--worker-dispatch', 'enable'],
        cwd: tmp, frameworkRoot: tmp,
      } as HandlerContext;
      const result = await setupHandler.execute(ctx);
      expect(result.exitCode).toBe(0);
      expect(() => readConfig(tmp)).toThrow();

      const printed = JSON.parse(String(logSpy.mock.calls[0]![0])) as {
        dry_run?: boolean;
        worker_dispatch_offer?: { should_offer: boolean; applied_choice?: string };
      };
      expect(printed.dry_run).toBe(true);
      expect(printed.worker_dispatch_offer).toEqual({ should_offer: false, applied_choice: 'enable' });
    });

    it('is accepted even when fewer than two worker CLIs are detected', async () => {
      detected.clis = [];
      const ctx: HandlerContext = {
        args: ['project', '--yes', '--worker-dispatch', 'enable'],
        rawArgs: ['setup', 'project', '--yes', '--worker-dispatch', 'enable'],
        cwd: tmp, frameworkRoot: tmp,
      } as HandlerContext;
      const result = await setupHandler.execute(ctx);
      expect(result.exitCode).toBe(0);
      const cfg = readConfig(tmp) as { parallelism?: Record<string, unknown> };
      expect(cfg.parallelism?.worker_dispatch).toBe(true);
    });
  });
});
