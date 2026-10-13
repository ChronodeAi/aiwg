/**
 * Unit tests for the direct-worker dispatch opt-in offer inside `aiwg init`
 * (#3050 item 1-3, and review items 1, 2, 7).
 *
 * Detection is mocked so these tests never depend on which worker CLIs the
 * running host actually has installed. `readline` is replaced with a small
 * queue-based fake so the interactive wizard runs deterministically. CI,
 * user model configuration (`AIWG_CONFIG`), and artifact-path environment
 * variables are isolated so these tests pass identically whether the host
 * is a developer workstation with real AIWG state or a bare `CI=true`
 * container (review item 7).
 *
 * @source @src/cli/handlers/init.ts
 * @implements #3050
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clearInteractiveEnv } from '../../../helpers/interactive-env.js';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';

const detected = vi.hoisted(() => ({ clis: [] as string[] }));
const rlQueue = vi.hoisted(() => ({ answers: [] as string[] }));

vi.mock('../../../../src/models/worker-dispatch-offer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/models/worker-dispatch-offer.js')>();
  return { ...actual, detectInstalledWorkerClis: vi.fn(() => detected.clis) };
});

vi.mock('readline', () => ({
  default: {
    createInterface: vi.fn(() => ({
      question: (_prompt: string, cb: (a: string) => void) => {
        cb(rlQueue.answers.length > 0 ? rlQueue.answers.shift()! : '');
      },
      // askConsent attaches a 'close' listener; these tests never emit it,
      // so a no-op is sufficient here (unlike setup's dedicated 'closed'
      // regression test below, which builds its own emitter-backed fake).
      on: () => {},
      removeListener: () => {},
      close: vi.fn(),
    })),
  },
}));

function makeTmpDir(): string {
  const dir = join(tmpdir(), `aiwg-init-worker-offer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCtx(tmpDir: string, args: string[] = []): HandlerContext {
  return {
    args,
    rawArgs: ['init', ...args],
    cwd: tmpDir,
    frameworkRoot: tmpDir,
    dryRun: args.includes('--dry-run'),
  } as HandlerContext;
}

let restoreInteractiveEnv: () => void = () => {};
const ARTIFACT_ENV_KEYS = ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR'] as const;

describe('aiwg init — worker dispatch opt-in offer (#3050)', () => {
  let tmpDir: string;
  let isolatedHome: string;
  const originalStdinTTY = process.stdin.isTTY;
  const originalStdoutTTY = process.stdout.isTTY;
  let previousArtifactEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    isolatedHome = mkdtempSync(join(tmpdir(), 'aiwg-init-worker-offer-home-'));
    detected.clis = [];
    rlQueue.answers = [];
    // `--non-interactive` tests set the flag explicitly regardless of TTY;
    // the plain (no-flag) tests below exercise the interactive wizard, which
    // the handler otherwise treats as non-interactive under vitest (no real
    // TTY attached to the test process).
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    // Review item 7: isolate CI, user model configuration, and the home
    // directory so these tests pass identically on a developer workstation
    // with real AIWG state and in a bare CI=true container. Enabling
    // worker_dispatch makes writeAiwgConfig validate worker-model defaults
    // (reads AIWG_HOME + AIWG_CONFIG); point both at isolated locations
    // instead of a real home install.
    restoreInteractiveEnv = clearInteractiveEnv();
    vi.stubEnv('AIWG_HOME', process.cwd());
    vi.stubEnv('AIWG_CONFIG', join(isolatedHome, 'config'));
    vi.stubEnv('HOME', isolatedHome);
    vi.stubEnv('USERPROFILE', isolatedHome);
    previousArtifactEnv = Object.fromEntries(ARTIFACT_ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ARTIFACT_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(isolatedHome, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    restoreInteractiveEnv();
    for (const key of ARTIFACT_ENV_KEYS) {
      const value = previousArtifactEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    Object.defineProperty(process.stdin, 'isTTY', { value: originalStdinTTY, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutTTY, configurable: true });
  });

  describe('non-interactive (new config)', () => {
    it('leaves parallelism untouched when two or more worker CLIs are detected', async () => {
      detected.clis = ['codex', 'muse'];
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir, ['--non-interactive']));
      expect(result.exitCode).toBe(0);

      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = await readAiwgConfig(tmpDir);
      expect(cfg!.parallelism?.worker_dispatch).toBeUndefined();
      expect(cfg!.setup?.worker_dispatch_offer).toBeUndefined();
    });
  });

  describe('interactive (new config)', () => {
    /** Providers prompt answer '', add-default-scripts answer '' (= no,
     * skipping the custom-script sub-prompts), then the worker-dispatch
     * question (only asked when the offer applies and not dry-run). */
    function queueFor(workerDispatchAnswer: string): string[] {
      return ['', '', workerDispatchAnswer];
    }

    it('offers and enables on yes, with two or more worker CLIs detected', async () => {
      detected.clis = ['codex', 'muse'];
      rlQueue.answers = queueFor('y');
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir));
      expect(result.exitCode).toBe(0);

      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = await readAiwgConfig(tmpDir);
      expect(cfg!.parallelism?.worker_dispatch).toBe(true);
    });

    it('defaults to no (declines and remembers) on empty input', async () => {
      detected.clis = ['codex', 'muse'];
      rlQueue.answers = queueFor('');
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir));
      expect(result.exitCode).toBe(0);

      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = await readAiwgConfig(tmpDir);
      expect(cfg!.parallelism?.worker_dispatch).not.toBe(true);
      expect(cfg!.setup?.worker_dispatch_offer).toBe('declined');
    });

    // Review item 2: 'yesterday' merely starts with 'y' and must not be
    // accepted as consent — only exact (trimmed, case-insensitive) 'y'/'yes'.
    it('treats "yesterday" as a decline, not an enable (strict consent parsing)', async () => {
      detected.clis = ['codex', 'muse'];
      rlQueue.answers = queueFor('yesterday');
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir));
      expect(result.exitCode).toBe(0);

      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = await readAiwgConfig(tmpDir);
      expect(cfg!.parallelism?.worker_dispatch).not.toBe(true);
      expect(cfg!.setup?.worker_dispatch_offer).toBe('declined');
    });

    it('does not offer with only one detected worker CLI', async () => {
      detected.clis = ['codex'];
      // Only the providers + add-scripts answers are needed; if the offer
      // wrongly fired it would consume this 'y' as the worker-dispatch
      // answer and incorrectly enable dispatch.
      rlQueue.answers = ['', ''];
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir));
      expect(result.exitCode).toBe(0);

      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = await readAiwgConfig(tmpDir);
      expect(cfg!.parallelism?.worker_dispatch).toBeUndefined();
      expect(cfg!.setup?.worker_dispatch_offer).toBeUndefined();
    });

    // Review item 1: --dry-run must never prompt for, or write, the offer
    // decision — even though the rest of the wizard (providers/scripts)
    // still runs and the overall config write is unrelated pre-existing
    // behavior this fix does not change.
    it('--dry-run never asks and never writes the offer, even though "y" is queued', async () => {
      detected.clis = ['codex', 'muse'];
      // Providers + add-scripts answers only; if the dispatch question
      // were (wrongly) asked during a dry run, it would have nothing left
      // to consume and would fall back to '' (decline) rather than 'y' —
      // so to prove it was never asked at all, assert neither field is set.
      rlQueue.answers = ['', ''];
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir, ['--dry-run']));
      expect(result.exitCode).toBe(0);

      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = await readAiwgConfig(tmpDir);
      expect(cfg?.parallelism?.worker_dispatch).toBeUndefined();
      expect(cfg?.setup?.worker_dispatch_offer).toBeUndefined();
    });
  });

  describe('existing config (re-running aiwg init)', () => {
    async function writeExistingConfig(overrides: Record<string, unknown> = {}): Promise<void> {
      const { emptyConfig, writeAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = emptyConfig(['claude']);
      Object.assign(cfg, overrides);
      await writeAiwgConfig(tmpDir, cfg);
    }

    it('non-interactive: hints but never writes when dispatch is off and two CLIs are detected', async () => {
      await writeExistingConfig();
      detected.clis = ['codex', 'muse'];
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir, ['--non-interactive']));
      expect(result.exitCode).toBe(0);

      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = await readAiwgConfig(tmpDir);
      expect(cfg!.parallelism?.worker_dispatch).toBeUndefined();
      expect(cfg!.setup?.worker_dispatch_offer).toBeUndefined();
    });

    it('interactive: a decline is remembered and not re-asked on a later run', async () => {
      await writeExistingConfig();
      detected.clis = ['codex', 'muse'];
      rlQueue.answers = [''];
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const first = await initHandler.execute(makeCtx(tmpDir));
      expect(first.exitCode).toBe(0);

      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      let cfg = await readAiwgConfig(tmpDir);
      expect(cfg!.setup?.worker_dispatch_offer).toBe('declined');

      // Second run: if the offer fired again it would consume this 'y' and
      // flip worker_dispatch on; it must not, because the decline is remembered.
      rlQueue.answers = ['y'];
      const second = await initHandler.execute(makeCtx(tmpDir));
      expect(second.exitCode).toBe(0);
      cfg = await readAiwgConfig(tmpDir);
      expect(cfg!.parallelism?.worker_dispatch).not.toBe(true);
      expect(cfg!.setup?.worker_dispatch_offer).toBe('declined');
    });

    // Review item 1: re-running `aiwg init --dry-run` on an existing config
    // used to write a decline/enable for both answers; it must now write
    // nothing and never even open the prompt.
    it('--dry-run never asks and never writes, even though "y" is queued', async () => {
      await writeExistingConfig();
      detected.clis = ['codex', 'muse'];
      rlQueue.answers = ['y'];
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir, ['--dry-run']));
      expect(result.exitCode).toBe(0);

      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = await readAiwgConfig(tmpDir);
      expect(cfg!.parallelism?.worker_dispatch).toBeUndefined();
      expect(cfg!.setup?.worker_dispatch_offer).toBeUndefined();
      // The queued 'y' was never consumed because the prompt was never asked.
      expect(rlQueue.answers).toEqual(['y']);
    });
  });

  describe('--worker-dispatch argument (#3062)', () => {
    it('rejects an invalid value, naming the accepted values, without writing', async () => {
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir, ['--non-interactive', '--worker-dispatch', 'bogus']));
      expect(result.exitCode).not.toBe(0);
      expect(result.message).toMatch(/--worker-dispatch must be one of: enable, decline/);

      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      expect(await readAiwgConfig(tmpDir)).toBeNull();
    });

    it('enables directly, headless, with only one detected worker CLI (explicit choice overrides detection)', async () => {
      detected.clis = ['codex']; // below the 2-CLI auto-offer threshold
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir, ['--non-interactive', '--worker-dispatch', 'enable']));
      expect(result.exitCode).toBe(0);

      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = await readAiwgConfig(tmpDir);
      expect(cfg!.parallelism?.worker_dispatch).toBe(true);
    });

    it('declines directly, headless, without ever asking', async () => {
      detected.clis = ['codex', 'muse'];
      rlQueue.answers = []; // nothing queued — a prompt attempt would fail with no answer
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir, ['--non-interactive', '--worker-dispatch', 'decline']));
      expect(result.exitCode).toBe(0);

      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = await readAiwgConfig(tmpDir);
      expect(cfg!.setup?.worker_dispatch_offer).toBe('declined');
    });

    it('suppresses the interactive question when given with a terminal attached', async () => {
      detected.clis = ['codex', 'muse'];
      rlQueue.answers = ['', '']; // providers + add-scripts only; dispatch question must not be asked
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir, ['--worker-dispatch', 'enable']));
      expect(result.exitCode).toBe(0);
      expect(rlQueue.answers).toEqual([]);

      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = await readAiwgConfig(tmpDir);
      expect(cfg!.parallelism?.worker_dispatch).toBe(true);
    });

    // Review item 18 (#3062 follow-up): `aiwg init --dry-run` now writes
    // nothing at all on a new config — not just the worker-dispatch field.
    it('--dry-run writes nothing at all on a new config, even with --worker-dispatch', async () => {
      detected.clis = ['codex', 'muse'];
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir, ['--dry-run', '--worker-dispatch', 'enable']));
      expect(result.exitCode).toBe(0);

      const { readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = await readAiwgConfig(tmpDir);
      expect(cfg).toBeNull();
    });

    it('--dry-run writes nothing even with the argument, on an existing config', async () => {
      const { emptyConfig, writeAiwgConfig, readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      await writeAiwgConfig(tmpDir, emptyConfig(['claude']));
      detected.clis = ['codex', 'muse'];
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir, ['--dry-run', '--worker-dispatch', 'decline']));
      expect(result.exitCode).toBe(0);

      const cfg = await readAiwgConfig(tmpDir);
      expect(cfg!.setup?.worker_dispatch_offer).toBeUndefined();
    });

    it('applies an explicit enable on an existing config headless, overriding a prior decline', async () => {
      const { emptyConfig, writeAiwgConfig, readAiwgConfig } = await import('../../../../src/config/aiwg-config.js');
      const cfg = emptyConfig(['claude']);
      cfg.setup = { worker_dispatch_offer: 'declined' };
      await writeAiwgConfig(tmpDir, cfg);
      detected.clis = ['codex', 'muse'];
      const { initHandler } = await import('../../../../src/cli/handlers/init.js');
      const result = await initHandler.execute(makeCtx(tmpDir, ['--non-interactive', '--worker-dispatch', 'enable']));
      expect(result.exitCode).toBe(0);

      const updated = await readAiwgConfig(tmpDir);
      expect(updated!.parallelism?.worker_dispatch).toBe(true);
    });
  });
});
