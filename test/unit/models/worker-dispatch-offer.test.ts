/**
 * Unit tests for the direct-worker dispatch opt-in offer (#3050).
 *
 * @source @src/models/worker-dispatch-offer.ts
 * @implements #3050
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import {
  knownWorkerCliExecutables,
  detectInstalledWorkerClis,
  evaluateWorkerDispatchOffer,
  workerDispatchOfferQuestion,
  workerDispatchOfferHint,
  WORKER_DISPATCH_ENABLE_COMMAND,
} from '../../../src/models/worker-dispatch-offer.js';
import type { ProviderModelCapabilityRegistry } from '../../../src/models/provider-policy.js';

/** Minimal registry fixture: only the fields knownWorkerCliExecutables reads. */
function fakeRegistry(entries: Record<string, { executable?: string; kind?: 'process' | 'http'; health?: boolean }>): ProviderModelCapabilityRegistry {
  const providers: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(entries)) {
    const adapter = entry.executable === undefined
      ? undefined
      : { invocation: entry.kind === 'http' ? { kind: 'http' } : { kind: 'process', executable: entry.executable } };
    providers[id] = entry.health ? { workerHealthAdapter: adapter } : { workerAdapter: adapter };
  }
  return { providers } as unknown as ProviderModelCapabilityRegistry;
}

const scratchDirs: string[] = [];
function makeBinDir(executables: string[], options: { executable?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiwg-worker-dispatch-offer-'));
  scratchDirs.push(dir);
  for (const name of executables) {
    const file = join(dir, name);
    writeFileSync(file, '#!/bin/sh\necho test\n');
    chmodSync(file, options.executable === false ? 0o644 : 0o755);
  }
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('knownWorkerCliExecutables', () => {
  it('collects process-adapter executables from workerAdapter, deduplicated and sorted', () => {
    const registry = fakeRegistry({
      codex: { executable: 'codex' },
      muse: { executable: 'muse' },
      claude: { executable: 'claude' },
    });
    expect(knownWorkerCliExecutables(registry)).toEqual(['claude', 'codex', 'muse']);
  });

  it('falls back to workerHealthAdapter when no workerAdapter is pinned', () => {
    const registry = fakeRegistry({ grokbot: { executable: 'grok-cli', health: true } });
    expect(knownWorkerCliExecutables(registry)).toEqual(['grok-cli']);
  });

  it('skips providers with no adapter and non-process (http) adapters', () => {
    const registry = fakeRegistry({
      none: {},
      http: { executable: 'ignored', kind: 'http' },
      codex: { executable: 'codex' },
    });
    expect(knownWorkerCliExecutables(registry)).toEqual(['codex']);
  });
});

describe('detectInstalledWorkerClis', () => {
  it('detects only known executables present on the given PATH', () => {
    const registry = fakeRegistry({ codex: { executable: 'codex' }, muse: { executable: 'muse' } });
    const bin = makeBinDir(['codex']);
    expect(detectInstalledWorkerClis({ registry, pathEnv: bin })).toEqual(['codex']);
  });

  it('returns nothing when no known executable is present', () => {
    const registry = fakeRegistry({ codex: { executable: 'codex' }, muse: { executable: 'muse' } });
    const bin = makeBinDir(['some-other-tool']);
    expect(detectInstalledWorkerClis({ registry, pathEnv: bin })).toEqual([]);
  });

  it('is presence-only: a non-executable file with a matching name does not count', () => {
    const registry = fakeRegistry({ codex: { executable: 'codex' } });
    const bin = makeBinDir(['codex'], { executable: false });
    expect(detectInstalledWorkerClis({ registry, pathEnv: bin })).toEqual([]);
  });

  it('scans every directory on a multi-entry PATH', () => {
    const registry = fakeRegistry({ codex: { executable: 'codex' }, muse: { executable: 'muse' } });
    const binA = makeBinDir(['codex']);
    const binB = makeBinDir(['muse']);
    expect(detectInstalledWorkerClis({ registry, pathEnv: `${binA}${delimiter}${binB}` })).toEqual(['codex', 'muse']);
  });

  // #3050 review item 8: an `X_OK` access check alone also succeeds for a
  // searchable directory, so a directory on PATH that happens to share a
  // worker CLI's name must never count as installed.
  it('does not count an executable (searchable) directory as an installed CLI', () => {
    const registry = fakeRegistry({ codex: { executable: 'codex' } });
    const bin = mkdtempSync(join(tmpdir(), 'aiwg-worker-dispatch-offer-'));
    scratchDirs.push(bin);
    const asDir = join(bin, 'codex');
    mkdirSync(asDir, { recursive: true });
    // Directories are searchable (x) by default from mkdir; make it explicit.
    chmodSync(asDir, 0o755);
    expect(detectInstalledWorkerClis({ registry, pathEnv: bin })).toEqual([]);
  });

  it('still counts a symlink to a regular executable file', () => {
    const registry = fakeRegistry({ codex: { executable: 'codex' } });
    const bin = makeBinDir(['codex-real']);
    symlinkSync(join(bin, 'codex-real'), join(bin, 'codex'));
    expect(detectInstalledWorkerClis({ registry, pathEnv: bin })).toEqual(['codex']);
  });
});

describe('evaluateWorkerDispatchOffer', () => {
  it('offers when two or more worker CLIs are detected and dispatch is off', () => {
    expect(evaluateWorkerDispatchOffer(undefined, undefined, ['codex', 'muse'])).toEqual({
      shouldOffer: true, detected: ['codex', 'muse'],
    });
  });

  it('does not offer with only one detected CLI', () => {
    expect(evaluateWorkerDispatchOffer(undefined, undefined, ['codex']).shouldOffer).toBe(false);
  });

  it('does not offer with zero detected CLIs', () => {
    expect(evaluateWorkerDispatchOffer(undefined, undefined, []).shouldOffer).toBe(false);
  });

  it('does not offer when worker_dispatch is already on, regardless of detected count', () => {
    expect(evaluateWorkerDispatchOffer({ worker_dispatch: true }, undefined, ['codex', 'muse']).shouldOffer).toBe(false);
  });

  // #3050 fix-first: the decline lives in `setup` (a plain onboarding
  // preference), not in `parallelism` (the frozen B-OG-29 contract fragment).
  it('does not offer when a previous decline was recorded, regardless of detected count', () => {
    expect(evaluateWorkerDispatchOffer(undefined, { worker_dispatch_offer: 'declined' }, ['codex', 'muse']).shouldOffer).toBe(false);
  });

  it('offers again when setup has no recorded decline', () => {
    expect(evaluateWorkerDispatchOffer(undefined, {}, ['codex', 'muse']).shouldOffer).toBe(true);
  });
});

describe('workerDispatchOfferQuestion', () => {
  it('defaults the answer to no and names the detected CLIs', () => {
    const question = workerDispatchOfferQuestion(['codex', 'muse']);
    expect(question).toContain('[y/N]');
    expect(question).toContain('codex, muse');
  });
});

describe('workerDispatchOfferHint', () => {
  it('names the enable command, the readiness check, and the detected CLIs', () => {
    const hint = workerDispatchOfferHint(['codex', 'muse']);
    expect(hint).toContain(WORKER_DISPATCH_ENABLE_COMMAND);
    expect(hint).toContain('aiwg doctor --probe-workers');
    expect(hint).toContain('codex, muse');
  });
});
