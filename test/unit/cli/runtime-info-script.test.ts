/**
 * Unit tests for tools/cli/runtime-info.mjs (the legacy script behind
 * `aiwg sync`), scoped to `isClaudeCodeSession()` (#2623, #2627, #3054).
 *
 * This must be hermetic against whatever Claude-Code-shaped env vars the
 * host running this suite happens to have set — this suite may itself be
 * invoked from inside a live Claude Code session — and against process
 * ancestry, which `detectProviderFromProcessTree()` in this script also
 * checks independently of `isClaudeCodeSession()`.
 *
 * Both resolution paths are exercised deterministically via
 * `AIWG_RESOLVE_IMPL_FROM`:
 *  - `dist` forces the shared `resolveActiveProvider` path (requires a
 *    build; skipped when dist/src is not present).
 *  - `src` forces the no-build-output fallback (provider-resolution.ts has
 *    internal relative imports Node cannot resolve without a build, so this
 *    deterministically exercises the literal marker-check fallback).
 *
 * @implements #3054
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { listProviderDefinitions } from '../../../src/providers/provider-definitions.js';

const __dir = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dir, '../../../');
const distBuilt = existsSync(resolve(REPO_ROOT, 'dist/src/cli/provider-resolution.js'));

const PROVIDER_ENV_KEYS = Array.from(
  new Set(['CLAUDE_CODE_VERSION', 'ANTHROPIC_API_KEY', ...listProviderDefinitions().flatMap((d) => d.detection.env)]),
);
const saved = new Map<string, string | undefined>();
const originalResolveImplFrom = process.env.AIWG_RESOLVE_IMPL_FROM;

beforeEach(() => {
  for (const key of PROVIDER_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PROVIDER_ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  if (originalResolveImplFrom === undefined) delete process.env.AIWG_RESOLVE_IMPL_FROM;
  else process.env.AIWG_RESOLVE_IMPL_FROM = originalResolveImplFrom;
});

// isClaudeCodeSession re-reads process.env (through importImpl, which reads
// AIWG_RESOLVE_IMPL_FROM live) on every call, so importing the module once
// and calling it repeatedly under different env is safe -- the module has
// no cached state of its own.
const runtimeInfoScript = import('../../../tools/cli/runtime-info.mjs');

describe('tools/cli/runtime-info.mjs: isClaudeCodeSession (shared resolution path)', () => {
  beforeEach(() => {
    if (!distBuilt) return;
    process.env.AIWG_RESOLVE_IMPL_FROM = 'dist';
  });

  it.runIf(distBuilt)('detects Claude Code when current markers are present', async () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    const { isClaudeCodeSession } = await runtimeInfoScript;
    await expect(isClaudeCodeSession()).resolves.toBe(true);
  });

  it.runIf(distBuilt)('does not detect Claude Code from ANTHROPIC_API_KEY alone (false-positive fix)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-not-actually-claude-code';
    const { isClaudeCodeSession } = await runtimeInfoScript;
    await expect(isClaudeCodeSession()).resolves.toBe(false);
  });

  it.runIf(distBuilt)('does not detect Claude Code when neither stale nor current markers are present', async () => {
    const { isClaudeCodeSession } = await runtimeInfoScript;
    await expect(isClaudeCodeSession()).resolves.toBe(false);
  });
});

describe('tools/cli/runtime-info.mjs: isClaudeCodeSession (no-build-output fallback)', () => {
  beforeEach(() => {
    process.env.AIWG_RESOLVE_IMPL_FROM = 'src';
  });

  it('detects Claude Code when current markers are present', async () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    const { isClaudeCodeSession } = await runtimeInfoScript;
    await expect(isClaudeCodeSession()).resolves.toBe(true);
  });

  it('does not detect Claude Code from ANTHROPIC_API_KEY alone (false-positive fix)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-not-actually-claude-code';
    const { isClaudeCodeSession } = await runtimeInfoScript;
    await expect(isClaudeCodeSession()).resolves.toBe(false);
  });

  it('does not detect Claude Code when neither stale nor current markers are present', async () => {
    const { isClaudeCodeSession } = await runtimeInfoScript;
    await expect(isClaudeCodeSession()).resolves.toBe(false);
  });
});
