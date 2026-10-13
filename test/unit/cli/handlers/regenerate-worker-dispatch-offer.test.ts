/**
 * Unit tests for the direct-worker dispatch opt-in hint inside `aiwg
 * regenerate` (#3050 item 4, and review item 7's "missing assertion").
 *
 * Detection is mocked so these tests never depend on which worker CLIs the
 * running host actually has installed — unlike the existing hint-adjacent
 * assertions in `regenerate.test.ts`, which observed the real host's
 * detected CLIs incidentally (this repo's dev host has several installed).
 *
 * @source @src/cli/handlers/regenerate.ts
 * @implements #3050
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';

const detected = vi.hoisted(() => ({ clis: [] as string[] }));

vi.mock('../../../../src/models/worker-dispatch-offer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/models/worker-dispatch-offer.js')>();
  return { ...actual, detectInstalledWorkerClis: vi.fn(() => detected.clis) };
});

vi.mock('../../../../src/cli/ui.js', () => ({
  blank: vi.fn(), rule: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(),
  dimText: vi.fn((s: string) => s), bold: vi.fn((s: string) => s), brandMark: vi.fn(() => '◆'),
}));

function makeTmpDir(): string {
  const dir = join(tmpdir(), `aiwg-regenerate-worker-offer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCtx(tmpDir: string, args: string[] = []): HandlerContext {
  return { args, rawArgs: ['regenerate', ...args], cwd: tmpDir, frameworkRoot: tmpDir };
}

function writeConfig(
  tmpDir: string,
  parallelism?: Record<string, unknown>,
  setup?: Record<string, unknown>,
): void {
  mkdirSync(join(tmpDir, '.aiwg'), { recursive: true });
  writeFileSync(join(tmpDir, '.aiwg', 'aiwg.config'), JSON.stringify({
    version: '1',
    providers: ['codex'],
    installed: {},
    scripts: {},
    ...(parallelism ? { parallelism } : {}),
    ...(setup ? { setup } : {}),
  }, null, 2));
}

describe('aiwg regenerate — worker dispatch opt-in hint (#3050)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    detected.clis = [];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function run(args: string[] = ['--dry-run', '--provider', 'codex']): Promise<string> {
    const { regenerateHandler } = await import('../../../../src/cli/handlers/regenerate.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await regenerateHandler.execute(makeCtx(tmpDir, args));
      expect(result.exitCode).toBe(0);
      return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    } finally {
      logSpy.mockRestore();
    }
  }

  it('prints the hint when dispatch is off and two or more worker CLIs are detected', async () => {
    writeConfig(tmpDir);
    detected.clis = ['codex', 'muse'];
    const printed = await run();
    expect(printed).toContain('aiwg config set --project parallelism.worker_dispatch true');
    expect(printed).toContain('codex, muse');
  });

  it('prints nothing when only one worker CLI is detected', async () => {
    writeConfig(tmpDir);
    detected.clis = ['codex'];
    const printed = await run();
    expect(printed).not.toContain('worker_dispatch');
  });

  it('prints nothing once dispatch is already on', async () => {
    writeConfig(tmpDir, { worker_dispatch: true });
    detected.clis = ['codex', 'muse'];
    const printed = await run();
    expect(printed).not.toContain('Direct worker dispatch is off');
  });

  // #3050 fix-first: the decline lives in `setup` (a plain onboarding
  // preference), not in `parallelism` (the frozen B-OG-29 contract fragment).
  it('prints nothing once a decline was recorded', async () => {
    writeConfig(tmpDir, undefined, { worker_dispatch_offer: 'declined' });
    detected.clis = ['codex', 'muse'];
    const printed = await run();
    expect(printed).not.toContain('Direct worker dispatch is off');
  });

  it('still prints the hint when no .aiwg/aiwg.config exists yet (parallelism is simply unset)', async () => {
    detected.clis = ['codex', 'muse'];
    const printed = await run(['--dry-run', '--provider', 'codex', '--workspace']);
    expect(printed).toContain('Direct worker dispatch is off');
  });
});
