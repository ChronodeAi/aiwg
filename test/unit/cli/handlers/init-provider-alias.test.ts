/**
 * Interactive `aiwg init` provider picker accepts registered provider aliases.
 *
 * The picker used to compare typed names against canonical ids only, so the
 * documented `dsh` alias for `deepseek-harness` was reported as an unknown
 * provider even though `--provider dsh` works everywhere else (#2161).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clearInteractiveEnv } from '../../../helpers/interactive-env.js';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';

const warn = vi.fn();

vi.mock('../../../../src/cli/ui.js', () => ({
  blank: vi.fn(),
  rule: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: (...args: unknown[]) => warn(...args),
  error: vi.fn(),
  dim: vi.fn(),
  dimText: vi.fn((s: string) => s),
  bold: vi.fn((s: string) => s),
  brandMark: vi.fn(() => '◆'),
}));

vi.mock('readline', () => ({
  default: {
    createInterface: vi.fn(() => ({ question: vi.fn(), close: vi.fn() })),
  },
}));

// First string prompt is the provider selection; every yes/no prompt declines.
const askString = vi.fn(async () => 'dsh, codex');
const askYesNo = vi.fn(async () => false);
// #3050: the worker-dispatch opt-in offer uses askConsent; this test isn't
// about that offer, so answer as a plain decline (irrelevant to the
// provider-alias assertions below) rather than hanging/crashing on a
// missing mock export.
const askConsent = vi.fn(async () => ({ kind: 'answered' as const, value: false }));
vi.mock('../../../../src/cli/prompt-utils.js', () => ({
  askString: (...args: unknown[]) => askString(...args),
  askYesNo: (...args: unknown[]) => askYesNo(...args),
  askConsent: (...args: unknown[]) => askConsent(...args),
}));

const { initHandler } = await import('../../../../src/cli/handlers/init.js');

function makeTmpDir(): string {
  const dir = join(tmpdir(), `aiwg-init-alias-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCtx(cwd: string): HandlerContext {
  return { args: [], rawArgs: ['init'], cwd, frameworkRoot: cwd };
}

describe('init interactive provider picker', () => {
  let tmpDir: string;
  const originalStdinTTY = process.stdin.isTTY;
  const originalStdoutTTY = process.stdout.isTTY;
  let restoreInteractiveEnv: () => void = () => {};

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // The handler treats a missing TTY on either stream, or CI=true, as
    // non-interactive; force the interactive wizard so the picker runs.
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    restoreInteractiveEnv = clearInteractiveEnv();
    warn.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalStdinTTY, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutTTY, configurable: true });
    restoreInteractiveEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves registered aliases such as dsh to their canonical provider id', async () => {
    const result = await initHandler.execute(makeCtx(tmpDir));
    expect(result.exitCode).toBe(0);

    const config = JSON.parse(readFileSync(join(tmpDir, '.aiwg', 'aiwg.config'), 'utf8'));
    expect(config.providers).toEqual(['deepseek-harness', 'codex']);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Unknown provider'));
  });
});
