/**
 * Unit tests for mc.ts Mission Control handler
 * Covers start, dispatch, status, watch, abort, pause, resume, stop, list subcommands.
 *
 * @issue #690
 * @parent #684
 */

import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';

// ── In-memory fs mock ─────────────────────────────────────────
// mc.ts uses node:fs/promises with relative paths. We mock the whole module
// with an in-memory store to avoid chdir (not supported in vitest workers).

type Dirent = { name: string; isDirectory: () => boolean; isFile: () => boolean };

const { inMemoryFs } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    inMemoryFs: {
      store,
      clear: () => store.clear(),
    },
  };
});

// mc.ts uses `import { promises as fs } from 'node:fs'` — must mock 'node:fs', not 'node:fs/promises'
vi.mock('node:fs', () => {
  const store = inMemoryFs.store;
  const fsMethods = {
    mkdir: vi.fn(async (_path: string) => undefined),
    readFile: vi.fn(async (path: string) => {
      const content = store.get(path);
      if (!content) throw Object.assign(new Error(`ENOENT: no such file ${path}`), { code: 'ENOENT' });
      return content;
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      store.set(path, content);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const content = store.get(from);
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' });
      store.set(to, content);
      store.delete(from);
    }),
    unlink: vi.fn(async (path: string) => { store.delete(path); }),
    open: vi.fn(async (path: string) => {
      if (store.has(path)) throw Object.assign(new Error(`EEXIST: ${path}`), { code: 'EEXIST' });
      store.set(path, 'locked');
      return { close: vi.fn(async () => undefined) };
    }),
    appendFile: vi.fn(async () => undefined),
    readdir: vi.fn(async (path: string, _opts?: unknown) => {
      const prefix = path.endsWith('/') ? path : path + '/';
      const dirs = new Set<string>();
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const part = rest.split('/')[0];
          if (part) dirs.add(part);
        }
      }
      return Array.from(dirs).map((name): Dirent => ({
        name,
        isDirectory: () => true,
        isFile: () => false,
      }));
    }),
  };
  return {
    promises: fsMethods,
    default: { promises: fsMethods },
  };
});

vi.mock('../../../../src/cli/ui.js', () => ({
  blank: vi.fn(),
  rule: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  dim: vi.fn(),
  bold: vi.fn((s: string) => s),
  brandMark: vi.fn(() => '◆'),
  dimText: vi.fn((s: string) => s),
  header: vi.fn(),
  accent: vi.fn((s: string) => s),
  error: vi.fn(),
}));

// #1439: mock launchExternalRalph so `mc run` tests don't spawn real subprocesses
vi.mock('../../../../src/cli/handlers/ralph-launcher.js', () => ({
  launchExternalRalph: vi.fn(async (_frameworkRoot: string, _projectRoot: string, options: { objective: string }) => ({
    loopId: `ralph-mock-${options.objective.replace(/\s+/g, '-').slice(0, 20)}`,
    pid: 99999,
    message: 'mock-launched',
  })),
}));

vi.mock('../../../../src/serve/shared-host-scheduler.js', () => ({
  FileAdmissionStore: class FileAdmissionStore {},
  SharedHostScheduler: class SharedHostScheduler {
    submit(request: { requestId: string }) {
      return {
        requestId: request.requestId,
        state: 'admitted',
        reason: 'admitted by test policy',
        leaseExpiresAt: '2026-08-03T12:05:00.000Z',
      };
    }
    renew(requestId: string) {
      return { requestId, state: 'admitted', leaseExpiresAt: '2026-08-03T12:05:00.000Z' };
    }
    release() { return { revision: 1, records: {} }; }
  },
}));

import {
  mcHandler,
  estimateMissionRunCost,
  SONNET_CACHE_USD,
  COST_REPORTING_PROVIDERS,
  RALPH_LOOP_PROVIDERS,
  ralphLoopProviders,
} from '../../../../src/cli/handlers/mc.js';
import { launchExternalRalph } from '../../../../src/cli/handlers/ralph-launcher.js';

// ── Helpers ───────────────────────────────────────────────────

function makeCtx(args: string[]): HandlerContext {
  return {
    args,
    rawArgs: ['mc', ...args],
    cwd: '/mock/cwd',
    frameworkRoot: '/mock/framework/root',
  };
}

beforeEach(() => {
  inMemoryFs.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── mcHandler metadata ────────────────────────────────────────

describe('mcHandler metadata', () => {
  it('has correct id and category', () => {
    expect(mcHandler.id).toBe('mc');
    expect(mcHandler.category).toBe('orchestration');
    expect(mcHandler.aliases).toContain('mission-control');
    expect(typeof mcHandler.execute).toBe('function');
  });
});

// ── No subcommand / help ──────────────────────────────────────

describe('mc (no subcommand)', () => {
  it('shows help and exits 0', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await mcHandler.execute(makeCtx([]));
    expect(result.exitCode).toBe(0);
    consoleSpy.mockRestore();
  });

  it('--help exits 0', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await mcHandler.execute(makeCtx(['--help']));
    expect(result.exitCode).toBe(0);
    consoleSpy.mockRestore();
  });

  it('unknown subcommand exits 1', async () => {
    const result = await mcHandler.execute(makeCtx(['bogus-subcommand']));
    expect(result.exitCode).toBe(1);
  });
});

// ── mc start ─────────────────────────────────────────────────

describe('mc start', () => {
  it('creates session and returns session ID in message', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await mcHandler.execute(makeCtx(['start']));
    expect(result.exitCode).toBe(0);
    expect(result.message).toBeDefined();
    expect(result.message).toMatch(/^mc-/);
    consoleSpy.mockRestore();
  });

  it('--name sets display name (exits 0)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await mcHandler.execute(makeCtx(['start', '--name', 'Sprint 4']));
    expect(result.exitCode).toBe(0);
    consoleSpy.mockRestore();
  });
});

// ── mc dispatch ───────────────────────────────────────────────

describe('mc dispatch', () => {
  const integerFlags = ['--max-iterations', '--max-total-tokens', '--max-output-tokens', '--max-tool-calls', '--exploration-quota'];
  const decimalFlags = ['--max-total-cost', '--max-wall-clock-minutes'];
  for (const flag of [...integerFlags, ...decimalFlags]) {
    const invalid = ['1junk', '1,000', '0x10', '0', '-1', 'Infinity', ''];
    if (integerFlags.includes(flag)) invalid.push('1.5', '9007199254740992');
    for (const syntax of ['separate', 'equals']) {
      it.each(invalid)(`rejects ${syntax} ${flag}=%s without changing session state`, async raw => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const started = await mcHandler.execute(makeCtx(['start']));
        expect(started.exitCode).toBe(0);
        const before = [...inMemoryFs.store.entries()];
        const args = syntax === 'equals' ? [`${flag}=${raw}`] : [flag, raw];
        const result = await mcHandler.execute(makeCtx(['dispatch', started.message!, 'Synthetic mission', ...args]));
        expect([...inMemoryFs.store.entries()]).toEqual(before);
        expect(result.exitCode).toBe(1);
        const ui = await import('../../../../src/cli/ui.js');
        expect(ui.error).toHaveBeenCalledWith(expect.stringContaining(flag));
        expect(launchExternalRalph).not.toHaveBeenCalled();
      });
    }
    it(`rejects missing ${flag} value without dispatching`, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const started = await mcHandler.execute(makeCtx(['start']));
      const before = [...inMemoryFs.store.entries()];
      const result = await mcHandler.execute(makeCtx(['dispatch', started.message!, 'Synthetic mission', flag]));
      expect([...inMemoryFs.store.entries()]).toEqual(before);
      expect(result.exitCode).toBe(1);
      expect(launchExternalRalph).not.toHaveBeenCalled();
    });
  }

  it.each(['separate', 'equals'])('persists exact valid numeric values using %s syntax', async syntax => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const started = await mcHandler.execute(makeCtx(['start']));
    const values = [...integerFlags.map(flag => [flag, '1e2']), ...decimalFlags.map(flag => [flag, '0.25'])];
    const args = values.flatMap(([flag, raw]) => syntax === 'equals' ? [`${flag}=${raw}`] : [flag, raw]);
    const result = await mcHandler.execute(makeCtx(['dispatch', started.message!, 'Synthetic mission', ...args]));
    expect(result.exitCode).toBe(0);
    const saved = JSON.parse(inMemoryFs.store.get(`.aiwg/ralph-external/mc/sessions/${started.message}/session.json`)!);
    expect(saved.missions).toHaveLength(1);
    expect(saved.missions[0]).toMatchObject({ maxIterations: 100, maxTotalTokens: 100, maxOutputTokens: 100,
      maxToolCalls: 100, explorationQuota: 100, maxTotalCost: 0.25, maxWallClockMinutes: 0.25 });
  });

  it('keeps quota disabled and iteration defaults when numeric flags are absent', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const started = await mcHandler.execute(makeCtx(['start']));
    expect((await mcHandler.execute(makeCtx(['dispatch', started.message!, 'Synthetic mission']))).exitCode).toBe(0);
    const saved = JSON.parse(inMemoryFs.store.get(`.aiwg/ralph-external/mc/sessions/${started.message}/session.json`)!);
    expect(saved.missions).toHaveLength(1);
    expect(saved.missions[0].maxIterations).toBe(10);
    expect(saved.missions[0]).not.toHaveProperty('explorationQuota');
    expect(saved.missions[0]).not.toHaveProperty('maxTotalTokens');
  });

  it('exits 1 when no objective given', async () => {
    const result = await mcHandler.execute(makeCtx(['dispatch']));
    expect(result.exitCode).toBe(1);
  });

  it('dispatches mission to session and returns mission ID', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const startResult = await mcHandler.execute(makeCtx(['start']));
    const sessionId = startResult.message!;
    const dispatchResult = await mcHandler.execute(
      makeCtx(['dispatch', sessionId, 'Fix auth module', '--completion', 'tests pass'])
    );
    expect(dispatchResult.exitCode).toBe(0);
    expect(dispatchResult.message).toMatch(/^m-/);
    consoleSpy.mockRestore();
  });

  it('persists LFD budget controls on dispatched missions', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const startResult = await mcHandler.execute(makeCtx(['start']));
    const sessionId = startResult.message!;
    await mcHandler.execute(
      makeCtx([
        'dispatch',
        sessionId,
        'Budgeted mission',
        '--completion',
        'tests pass',
        '--max-total-tokens',
        '5000',
        '--max-output-tokens',
        '1200',
        '--max-tool-calls',
        '20',
        '--max-total-cost',
        '3.50',
        '--max-wall-clock-minutes',
        '45',
        '--exploration-quota',
        '2',
      ]),
    );

    const jsonCalls: string[] = [];
    consoleSpy.mockImplementation((arg) => { jsonCalls.push(String(arg)); });
    await mcHandler.execute(makeCtx(['status', sessionId, '--json']));
    const jsonOutput = jsonCalls.find(s => { try { JSON.parse(s); return true; } catch { return false; } });
    const session = JSON.parse(jsonOutput!);
    const mission = session.missions[0];
    expect(mission.maxTotalTokens).toBe(5000);
    expect(mission.maxOutputTokens).toBe(1200);
    expect(mission.maxToolCalls).toBe(20);
    expect(mission.maxTotalCost).toBe(3.5);
    expect(mission.maxWallClockMinutes).toBe(45);
    expect(mission.explorationQuota).toBe(2);
    consoleSpy.mockRestore();
  });

  it('exits 1 when session not found', async () => {
    const result = await mcHandler.execute(
      makeCtx(['dispatch', 'mc-nonexistent', 'Do something'])
    );
    expect(result.exitCode).toBe(1);
  });

  it('refuses to dispatch on invalid numeric budget values instead of silently dropping them (#1770)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const startResult = await mcHandler.execute(makeCtx(['start']));
    const sessionId = startResult.message!;

    for (const badArgs of [
      ['--max-total-tokens', '5,000'],
      ['--max-total-cost', '-3.5'],
      ['--max-total-tokens', '0'],
      ['--max-iterations', 'abc'],
    ]) {
      const result = await mcHandler.execute(
        makeCtx(['dispatch', sessionId, 'Bad budget mission', '--completion', 'tests pass', ...badArgs]),
      );
      expect(result.exitCode).toBe(1);
    }

    // Nothing was dispatched
    const jsonCalls: string[] = [];
    consoleSpy.mockImplementation((arg) => { jsonCalls.push(String(arg)); });
    await mcHandler.execute(makeCtx(['status', sessionId, '--json']));
    const jsonOutput = jsonCalls.find(s => { try { JSON.parse(s); return true; } catch { return false; } });
    const session = JSON.parse(jsonOutput!);
    expect(session.missions).toHaveLength(0);
    consoleSpy.mockRestore();
  });

  it('accepts --flag=value syntax for budget flags (#1770)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const startResult = await mcHandler.execute(makeCtx(['start']));
    const sessionId = startResult.message!;
    await mcHandler.execute(
      makeCtx(['dispatch', sessionId, 'Equals mission', '--completion', 'tests pass', '--max-total-tokens=8000']),
    );

    const jsonCalls: string[] = [];
    consoleSpy.mockImplementation((arg) => { jsonCalls.push(String(arg)); });
    await mcHandler.execute(makeCtx(['status', sessionId, '--json']));
    const jsonOutput = jsonCalls.find(s => { try { JSON.parse(s); return true; } catch { return false; } });
    const session = JSON.parse(jsonOutput!);
    expect(session.missions[0].maxTotalTokens).toBe(8000);
    consoleSpy.mockRestore();
  });

  describe('--provider', () => {
    const sessionPath = (sessionId: string) => `.aiwg/ralph-external/mc/sessions/${sessionId}/session.json`;

    it.each([
      ['separate', ['--provider', 'omp']],
      ['equals', ['--provider=omp']],
      ['mixed-case', ['--provider', ' OMP ']],
    ])('persists the provider on the mission using %s syntax', async (_syntax, flag) => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const sessionId = (await mcHandler.execute(makeCtx(['start']))).message!;
      const result = await mcHandler.execute(makeCtx(['dispatch', sessionId, 'Omp mission', '--completion', 'tests pass', ...flag]));
      expect(result.exitCode).toBe(0);
      const saved = JSON.parse(inMemoryFs.store.get(sessionPath(sessionId))!);
      expect(saved.missions[0]).toMatchObject({ objective: 'Omp mission', provider: 'omp' });
    });

    it('leaves the provider unset when the flag is omitted (loop default, claude)', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const sessionId = (await mcHandler.execute(makeCtx(['start']))).message!;
      expect((await mcHandler.execute(makeCtx(['dispatch', sessionId, 'Default mission']))).exitCode).toBe(0);
      const saved = JSON.parse(inMemoryFs.store.get(sessionPath(sessionId))!);
      expect(saved.missions[0]).not.toHaveProperty('provider');
    });

    it.each([
      ['an unknown name', ['--provider', 'not-a-loop-provider'], "Unknown --provider 'not-a-loop-provider'"],
      ['a missing value', ['--provider'], '--provider requires a provider name'],
      ['an empty value', ['--provider='], '--provider requires a provider name'],
      ['a provider the loop has no adapter for', ['--provider', 'cursor'], "Unknown --provider 'cursor'"],
    ])('rejects %s without changing session state', async (_case, flag, problem) => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const sessionId = (await mcHandler.execute(makeCtx(['start']))).message!;
      const before = [...inMemoryFs.store.entries()];
      const result = await mcHandler.execute(makeCtx(['dispatch', sessionId, 'Bad provider mission', ...flag]));
      expect(result.exitCode).toBe(1);
      expect([...inMemoryFs.store.entries()]).toEqual(before);
      expect(result.message).toContain(problem);
      expect(result.message).toContain('claude, codex, opencode, factory, pi, omp, deepseek-harness, dsh');
      const ui = await import('../../../../src/cli/ui.js');
      expect(ui.error).toHaveBeenCalledWith(result.message);
    });

    it('rejects muse when AIWG_MUSE_RALPH_ENABLED disables it in the loop', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.stubEnv('AIWG_MUSE_RALPH_ENABLED', '0');
      try {
        const sessionId = (await mcHandler.execute(makeCtx(['start']))).message!;
        const result = await mcHandler.execute(makeCtx(['dispatch', sessionId, 'Muse mission', '--provider', 'muse']));
        expect(result.exitCode).toBe(1);
        expect(result.message).toContain("Unknown --provider 'muse'");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('shows the provider in mc status and mc list', async () => {
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((arg) => { lines.push(String(arg)); });
      const sessionId = (await mcHandler.execute(makeCtx(['start']))).message!;
      await mcHandler.execute(makeCtx(['dispatch', sessionId, 'Omp mission', '--provider', 'omp']));
      await mcHandler.execute(makeCtx(['dispatch', sessionId, 'Default mission']));

      lines.length = 0;
      await mcHandler.execute(makeCtx(['status', sessionId]));
      expect(lines.find(line => line.includes('Omp mission'))).toMatch(/\somp\s/);
      expect(lines.find(line => line.includes('Default mission'))).toMatch(/\sclaude\s/);
      expect(lines.some(line => line.includes('Provider'))).toBe(true);

      lines.length = 0;
      await mcHandler.execute(makeCtx(['status', sessionId, '--json']));
      const status = JSON.parse(lines.find(s => { try { JSON.parse(s); return true; } catch { return false; } })!);
      expect(status.missions.map((m: { provider?: string }) => m.provider)).toEqual(['omp', undefined]);

      lines.length = 0;
      await mcHandler.execute(makeCtx(['list', '--json']));
      const listed = JSON.parse(lines.find(s => { try { JSON.parse(s); return true; } catch { return false; } })!);
      expect(listed.find((s: { id: string }) => s.id === sessionId).providers).toEqual(['claude', 'omp']);

      lines.length = 0;
      await mcHandler.execute(makeCtx(['list']));
      expect(lines.find(line => line.includes(sessionId))).toContain('providers: claude, omp');
    });
  });
});

// ── mc status ────────────────────────────────────────────────

describe('mc status', () => {
  it('exits 1 when no active session', async () => {
    const result = await mcHandler.execute(makeCtx(['status']));
    expect(result.exitCode).toBe(1);
  });

  it('exits 0 when active session exists', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const startResult = await mcHandler.execute(makeCtx(['start']));
    const sessionId = startResult.message!;
    const result = await mcHandler.execute(makeCtx(['status', sessionId]));
    expect(result.exitCode).toBe(0);
    consoleSpy.mockRestore();
  });

  it('--json outputs parseable JSON when session found', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const startResult = await mcHandler.execute(makeCtx(['start']));
    const sessionId = startResult.message!;
    const jsonCalls: string[] = [];
    consoleSpy.mockImplementation((arg) => { jsonCalls.push(String(arg)); });
    await mcHandler.execute(makeCtx(['status', sessionId, '--json']));
    const jsonOutput = jsonCalls.find(s => { try { JSON.parse(s); return true; } catch { return false; } });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed).toHaveProperty('id', sessionId);
    consoleSpy.mockRestore();
  });

  it('--json outputs error when no session', async () => {
    const jsonCalls: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((arg) => { jsonCalls.push(String(arg)); });
    const result = await mcHandler.execute(makeCtx(['status', '--json']));
    expect(result.exitCode).toBe(1);
    const jsonOutput = jsonCalls.find(s => { try { JSON.parse(s); return true; } catch { return false; } });
    expect(jsonOutput).toBeDefined();
    expect(JSON.parse(jsonOutput!)).toHaveProperty('error');
    consoleSpy.mockRestore();
  });
});

// ── mc abort ─────────────────────────────────────────────────

describe('mc abort', () => {
  it('exits 1 when session or mission id missing', async () => {
    const result = await mcHandler.execute(makeCtx(['abort']));
    expect(result.exitCode).toBe(1);
  });

  it('aborts a mission and exits 0', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const startResult = await mcHandler.execute(makeCtx(['start']));
    const sessionId = startResult.message!;
    const dispatchResult = await mcHandler.execute(makeCtx(['dispatch', sessionId, 'Some task']));
    const missionId = dispatchResult.message!;
    const abortResult = await mcHandler.execute(makeCtx(['abort', sessionId, missionId]));
    expect(abortResult.exitCode).toBe(0);
    consoleSpy.mockRestore();
  });

  it('rejects stale revisions and replays an idempotent cancel', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sessionId = (await mcHandler.execute(makeCtx(['start']))).message!;
    const missionId = (await mcHandler.execute(makeCtx(['dispatch', sessionId, 'Some task']))).message!;
    const path = `.aiwg/ralph-external/mc/sessions/${sessionId}/session.json`;
    const current = JSON.parse(inMemoryFs.store.get(path)!);

    const stale = await mcHandler.execute(makeCtx([
      'cancel', sessionId, missionId,
      '--expected-updated-at', '2000-01-01T00:00:00.000Z',
      '--request-id', 'request-stale',
    ]));
    expect(stale.exitCode).toBe(3);

    const first = await mcHandler.execute(makeCtx([
      'cancel', sessionId, missionId,
      '--expected-updated-at', current.updatedAt,
      '--request-id', 'request-1',
    ]));
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.message!)).toMatchObject({ ok: true, replayed: false });

    const replay = await mcHandler.execute(makeCtx([
      'cancel', sessionId, missionId,
      '--request-id', 'request-1',
    ]));
    expect(replay.exitCode).toBe(0);
    expect(JSON.parse(replay.message!)).toMatchObject({ ok: true, replayed: true });
    consoleSpy.mockRestore();
  });
});

// ── mc pause / resume ────────────────────────────────────────

describe('mc pause and resume', () => {
  it('pause exits 1 when no active session', async () => {
    const result = await mcHandler.execute(makeCtx(['pause']));
    expect(result.exitCode).toBe(1);
  });

  it('pause → resume cycle works', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const startResult = await mcHandler.execute(makeCtx(['start']));
    const sessionId = startResult.message!;
    const pauseResult = await mcHandler.execute(makeCtx(['pause', sessionId]));
    expect(pauseResult.exitCode).toBe(0);
    const resumeResult = await mcHandler.execute(makeCtx(['resume', sessionId]));
    expect(resumeResult.exitCode).toBe(0);
    consoleSpy.mockRestore();
  });

  it('resume exits 1 when session is not paused', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const startResult = await mcHandler.execute(makeCtx(['start']));
    const sessionId = startResult.message!;
    // Active session, not paused
    const resumeResult = await mcHandler.execute(makeCtx(['resume', sessionId]));
    expect(resumeResult.exitCode).toBe(1);
    consoleSpy.mockRestore();
  });
});

// ── mc stop ───────────────────────────────────────────────────

describe('mc stop', () => {
  it('exits 1 when no active session', async () => {
    const result = await mcHandler.execute(makeCtx(['stop']));
    expect(result.exitCode).toBe(1);
  });

  it('stops session and exits 0', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const startResult = await mcHandler.execute(makeCtx(['start']));
    const sessionId = startResult.message!;
    const stopResult = await mcHandler.execute(makeCtx(['stop', sessionId]));
    expect(stopResult.exitCode).toBe(0);
    consoleSpy.mockRestore();
  });

  it('start → stop skipping pause is valid', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const startResult = await mcHandler.execute(makeCtx(['start']));
    const sessionId = startResult.message!;
    const stopResult = await mcHandler.execute(makeCtx(['stop', sessionId]));
    expect(stopResult.exitCode).toBe(0);
    consoleSpy.mockRestore();
  });

  it('dispatch on stopped session exits 1 (auto-detect finds no active session)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const startResult = await mcHandler.execute(makeCtx(['start']));
    const sessionId = startResult.message!;
    await mcHandler.execute(makeCtx(['stop', sessionId]));
    // Auto-detection (no explicit sessionId) filters for active/paused only — stopped session not found
    const dispatchResult = await mcHandler.execute(
      makeCtx(['dispatch', '--objective', 'New task'])
    );
    expect(dispatchResult.exitCode).toBe(1);
    consoleSpy.mockRestore();
  });
});

// ── mc list ───────────────────────────────────────────────────

describe('mc list', () => {
  it('exits 0 when no sessions (graceful empty)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await mcHandler.execute(makeCtx(['list']));
    expect(result.exitCode).toBe(0);
    consoleSpy.mockRestore();
  });

  it('--json outputs array', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await mcHandler.execute(makeCtx(['start', '--name', 'Test']));
    const jsonCalls: string[] = [];
    consoleSpy.mockImplementation((arg) => { jsonCalls.push(String(arg)); });
    await mcHandler.execute(makeCtx(['list', '--json']));
    const jsonOutput = jsonCalls.find(s => { try { JSON.parse(s); return true; } catch { return false; } });
    expect(jsonOutput).toBeDefined();
    expect(Array.isArray(JSON.parse(jsonOutput!))).toBe(true);
    consoleSpy.mockRestore();
  });
});

// ── mc watch ─────────────────────────────────────────────────

describe('mc watch', () => {
  it('exits 1 when no active session', async () => {
    const result = await mcHandler.execute(makeCtx(['watch']));
    expect(result.exitCode).toBe(1);
  });

  it('exits 0 when active session exists', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const startResult = await mcHandler.execute(makeCtx(['start']));
    const sessionId = startResult.message!;
    const watchResult = await mcHandler.execute(makeCtx(['watch', sessionId]));
    expect(watchResult.exitCode).toBe(0);
    consoleSpy.mockRestore();
  });
});

// ── mc run (#1439) ───────────────────────────────────────────

describe('mc run (#1439)', () => {
  it('exits 1 when session not found', async () => {
    const result = await mcHandler.execute(makeCtx(['run', 'mc-nonexistent']));
    expect(result.exitCode).toBe(1);
  });

  it('exits 0 with friendly message when no queued missions exist', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const startResult = await mcHandler.execute(makeCtx(['start']));
    const sessionId = startResult.message!;
    const runResult = await mcHandler.execute(makeCtx(['run', sessionId]));
    expect(runResult.exitCode).toBe(0);
    consoleSpy.mockRestore();
  });

  it('drains queued missions and flips them to running with ralph metadata', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const startResult = await mcHandler.execute(makeCtx(['start']));
    const sessionId = startResult.message!;

    // Dispatch a mission with --completion (required by mc run)
    await mcHandler.execute(makeCtx(['dispatch', sessionId, 'Fix the bug', '--completion', 'tests pass']));

    // Run drains the queue. --accept-cost bypasses the #1450 cost gate which
    // refuses to launch in non-TTY contexts above the estimate threshold.
    const runResult = await mcHandler.execute(makeCtx(['run', sessionId, '--accept-cost']));
    expect(runResult.exitCode).toBe(0);

    // Verify mission status now `running` with ralphLoopId + ralphPid persisted
    const jsonCalls: string[] = [];
    consoleSpy.mockImplementation((arg) => { jsonCalls.push(String(arg)); });
    await mcHandler.execute(makeCtx(['status', sessionId, '--json']));
    const jsonOutput = jsonCalls.find(s => { try { JSON.parse(s); return true; } catch { return false; } });
    expect(jsonOutput).toBeDefined();
    const session = JSON.parse(jsonOutput!);
    expect(session.missions).toHaveLength(1);
    const mission = session.missions[0];
    expect(mission.status).toBe('running');
    expect(mission.ralphLoopId).toMatch(/^ralph-mock-/);
    expect(mission.ralphPid).toBe(99999);
    expect(mission.startedAt).toBeDefined();
    consoleSpy.mockRestore();
  });

  it('passes LFD budget controls through to ralph external launcher', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const startResult = await mcHandler.execute(makeCtx(['start']));
    const sessionId = startResult.message!;

    await mcHandler.execute(
      makeCtx([
        'dispatch',
        sessionId,
        'Budgeted run',
        '--completion',
        'tests pass',
        '--max-total-tokens',
        '5000',
        '--max-output-tokens',
        '1200',
        '--max-tool-calls',
        '20',
        '--max-total-cost',
        '3.50',
        '--max-wall-clock-minutes',
        '45',
        '--exploration-quota',
        '2',
      ]),
    );

    const runResult = await mcHandler.execute(makeCtx(['run', sessionId, '--accept-cost']));
    expect(runResult.exitCode).toBe(0);
    expect(vi.mocked(launchExternalRalph)).toHaveBeenCalledWith(
      '/mock/framework/root',
      '/mock/cwd',
      expect.objectContaining({
        objective: 'Budgeted run',
        completionCriteria: 'tests pass',
        maxTotalTokens: 5000,
        maxOutputTokens: 1200,
        maxToolCalls: 20,
        maxTotalCost: 3.5,
        maxWallClockMinutes: 45,
        explorationQuota: 2,
      }),
    );
    consoleSpy.mockRestore();
  });

  it.each(['loops', 'archive'])('marks a launched mission done when %s/<loop-id>/session-state.json reports completed', async area => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const sessionId = (await mcHandler.execute(makeCtx(['start']))).message!;
    await mcHandler.execute(makeCtx(['dispatch', sessionId, 'Synced mission', '--completion', 'tests pass']));
    expect((await mcHandler.execute(makeCtx(['run', sessionId, '--accept-cost']))).exitCode).toBe(0);
    const sessionPath = `.aiwg/ralph-external/mc/sessions/${sessionId}/session.json`;
    const launched = JSON.parse(inMemoryFs.store.get(sessionPath)!).missions[0];
    expect(launched.status).toBe('running');

    // A running loop writes loops/<id>/; the orchestrator archives it on exit.
    inMemoryFs.store.set(
      `/mock/cwd/.aiwg/ralph-external/${area}/${launched.ralphLoopId}/session-state.json`,
      JSON.stringify({ status: 'completed', currentIteration: 1 }),
    );
    expect((await mcHandler.execute(makeCtx(['status', sessionId]))).exitCode).toBe(0);
    const synced = JSON.parse(inMemoryFs.store.get(sessionPath)!).missions[0];
    expect(synced).toMatchObject({ status: 'done', loop: 1, admissionState: 'released' });
    expect(synced.completedAt).toBeDefined();
  });

  it('passes each mission provider to the launcher and omits it when unset', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const sessionId = (await mcHandler.execute(makeCtx(['start']))).message!;
    await mcHandler.execute(makeCtx(['dispatch', sessionId, 'Omp run', '--completion', 'tests pass', '--provider', 'omp']));
    await mcHandler.execute(makeCtx(['dispatch', sessionId, 'Default run', '--completion', 'tests pass']));

    const runResult = await mcHandler.execute(makeCtx(['run', sessionId, '--accept-cost']));
    expect(runResult.exitCode).toBe(0);
    const launches = vi.mocked(launchExternalRalph).mock.calls.map(([, , options]) => options);
    expect(launches).toHaveLength(2);
    expect(launches[0]).toMatchObject({ objective: 'Omp run', provider: 'omp' });
    expect(launches[1]).toMatchObject({ objective: 'Default run' });
    expect(launches[1].provider).toBeUndefined();
  });

  it('lets declared omp ceilings lower the cost gate estimate', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // The gate refuses (rather than pausing) only in a non-interactive context.
    const isTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    onTestFinished(() => {
      if (isTTY) Object.defineProperty(process.stdout, 'isTTY', isTTY);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    });
    const sessionId = (await mcHandler.execute(makeCtx(['start']))).message!;
    // Uncapped floor: 2 x 10 x $1.60 = $32, far above the $5 gate. The omp
    // ceilings bound it to $4, so no --accept-cost is needed.
    for (const objective of ['Omp one', 'Omp two']) {
      await mcHandler.execute(makeCtx(['dispatch', sessionId, objective, '--completion', 'tests pass', '--provider', 'omp', '--max-total-cost', '2']));
    }
    const runResult = await mcHandler.execute(makeCtx(['run', sessionId]));
    expect(runResult.exitCode).toBe(0);
    expect(vi.mocked(launchExternalRalph)).toHaveBeenCalledTimes(2);

    // The same ceilings on a provider that reports no spend stay inert.
    const inertSession = (await mcHandler.execute(makeCtx(['start']))).message!;
    await mcHandler.execute(makeCtx(['dispatch', inertSession, 'Pi one', '--completion', 'tests pass', '--provider', 'pi', '--max-total-cost', '2']));
    const refused = await mcHandler.execute(makeCtx(['run', inertSession]));
    expect(refused.exitCode).toBe(1);
    const ui = await import('../../../../src/cli/ui.js');
    expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining('does not report spend (pi)'));
    expect(vi.mocked(launchExternalRalph)).toHaveBeenCalledTimes(2);
  });

  it('skips missions without --completion criteria (ralph requires one)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const startResult = await mcHandler.execute(makeCtx(['start']));
    const sessionId = startResult.message!;

    // Dispatch WITHOUT --completion
    await mcHandler.execute(makeCtx(['dispatch', sessionId, 'No-completion mission']));

    const runResult = await mcHandler.execute(makeCtx(['run', sessionId]));
    // Mission was skipped, no launch failure, so exit 0
    expect(runResult.exitCode).toBe(0);

    // Verify mission still queued (NOT marked running)
    const jsonCalls: string[] = [];
    consoleSpy.mockImplementation((arg) => { jsonCalls.push(String(arg)); });
    await mcHandler.execute(makeCtx(['status', sessionId, '--json']));
    const jsonOutput = jsonCalls.find(s => { try { JSON.parse(s); return true; } catch { return false; } });
    const session = JSON.parse(jsonOutput!);
    expect(session.missions[0].status).toBe('queued');
    expect(session.missions[0].ralphLoopId).toBeUndefined();
    consoleSpy.mockRestore();
  });

  it('skips pty-orchestrator missions (separate execution path)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const startResult = await mcHandler.execute(makeCtx(['start']));
    const sessionId = startResult.message!;

    await mcHandler.execute(makeCtx([
      'dispatch', sessionId, 'PTY mission',
      '--mode', 'pty-orchestrator',
      '--target-agent', 'agent-01',
      '--completion', 'done',
    ]));

    const runResult = await mcHandler.execute(makeCtx(['run', sessionId]));
    expect(runResult.exitCode).toBe(0);

    const jsonCalls: string[] = [];
    consoleSpy.mockImplementation((arg) => { jsonCalls.push(String(arg)); });
    await mcHandler.execute(makeCtx(['status', sessionId, '--json']));
    const jsonOutput = jsonCalls.find(s => { try { JSON.parse(s); return true; } catch { return false; } });
    const session = JSON.parse(jsonOutput!);
    expect(session.missions[0].status).toBe('queued'); // skipped, still queued
    consoleSpy.mockRestore();
  });
});

// ── Cost estimate (#2522) ─────────────────────────────────────
// The gate previously ignored declared `maxTotalCost` entirely. These cover the
// three cases the fix must distinguish: no ceilings, ceilings on a provider that
// reports spend, and ceilings on a provider that does not (#1766). The provider
// is each mission's own (`--provider`), defaulting to claude.
describe('estimateMissionRunCost (#2522)', () => {
  const mission = (maxIterations: number, maxTotalCost?: number, provider?: string) => ({ maxIterations, maxTotalCost, provider });

  it('falls back to the uncapped iteration floor when no ceilings are declared', () => {
    const estimate = estimateMissionRunCost([mission(10), mission(5)]);
    expect(estimate.estimateUsd).toBeCloseTo(15 * SONNET_CACHE_USD, 5);
    expect(estimate.iterationFloorUsd).toBeCloseTo(15 * SONNET_CACHE_USD, 5);
    expect(estimate.declaredCeilingUsd).toBe(0);
    expect(estimate.cappedMissions).toBe(0);
    expect(estimate.inertCeilingMissions).toBe(0);
  });

  it('caps each mission at its declared ceiling when the provider reports spend', () => {
    // Ten missions capped at $1 each: the uncapped floor is 10 x 10 x $1.60 =
    // $160, while the enforced ceiling total is $10. No --provider means claude.
    const missions = Array.from({ length: 10 }, () => mission(10, 1));
    const estimate = estimateMissionRunCost(missions);
    expect(estimate.cappedProviders).toEqual(['claude']);
    expect(estimate.estimateUsd).toBeCloseTo(10, 5);
    expect(estimate.iterationFloorUsd).toBeCloseTo(160, 5);
    expect(estimate.declaredCeilingUsd).toBeCloseTo(10, 5);
    expect(estimate.cappedCeilingUsd).toBeCloseTo(10, 5);
    expect(estimate.cappedMissions).toBe(10);
    expect(estimate.inertCeilingMissions).toBe(0);
  });

  it('counts omp ceilings because omp reports spend', () => {
    expect(COST_REPORTING_PROVIDERS.has('omp')).toBe(true);
    const missions = Array.from({ length: 10 }, () => mission(10, 1, 'omp'));
    const estimate = estimateMissionRunCost(missions);
    expect(estimate.cappedProviders).toEqual(['omp']);
    expect(estimate.cappedMissions).toBe(10);
    expect(estimate.estimateUsd).toBeCloseTo(10, 5);
    expect(estimate.inertCeilingMissions).toBe(0);
    expect(estimate.inertProviders).toEqual([]);
  });

  it('never caps below the floor when a ceiling exceeds it', () => {
    const estimate = estimateMissionRunCost([mission(2, 999)]);
    expect(estimate.estimateUsd).toBeCloseTo(2 * SONNET_CACHE_USD, 5);
    expect(estimate.cappedMissions).toBe(1);
  });

  it('does not weaken the estimate when spend is unobservable on the provider', () => {
    const missions = Array.from({ length: 10 }, () => mission(10, 1, 'codex'));
    const estimate = estimateMissionRunCost(missions);
    expect(estimate.inertProviders).toEqual(['codex']);
    expect(estimate.cappedProviders).toEqual([]);
    // Inert ceilings must not shrink the warning: the operator has no enforced
    // protection here, which is exactly when the gate matters most.
    expect(estimate.estimateUsd).toBeCloseTo(160, 5);
    expect(estimate.declaredCeilingUsd).toBeCloseTo(10, 5);
    expect(estimate.inertCeilingUsd).toBeCloseTo(10, 5);
    expect(estimate.cappedMissions).toBe(0);
    expect(estimate.inertCeilingMissions).toBe(10);
  });

  it('judges each mission by its own provider in a mixed queue', () => {
    const estimate = estimateMissionRunCost([mission(10, 2, 'omp'), mission(10, 3, 'pi'), mission(10, 4)]);
    expect(estimate.cappedMissions).toBe(2);
    expect(estimate.cappedCeilingUsd).toBeCloseTo(6, 5);
    expect(estimate.cappedProviders).toEqual(['claude', 'omp']);
    expect(estimate.inertCeilingMissions).toBe(1);
    expect(estimate.inertCeilingUsd).toBeCloseTo(3, 5);
    expect(estimate.inertProviders).toEqual(['pi']);
    expect(estimate.declaredCeilingUsd).toBeCloseTo(9, 5);
    expect(estimate.estimateUsd).toBeCloseTo(2 + 10 * SONNET_CACHE_USD + 4, 5);
  });

  it('treats an unrecognized provider as unobservable rather than assuming cost reporting', () => {
    // Any provider outside COST_REPORTING_PROVIDERS. Spelled differently here
    // so the mission-protocol inventory scanner does not read a provider name
    // as mission status vocabulary.
    const estimate = estimateMissionRunCost([mission(10, 1, 'not-a-configured-provider')]);
    expect(estimate.inertProviders).toEqual(['not-a-configured-provider']);
    expect(estimate.estimateUsd).toBeCloseTo(10 * SONNET_CACHE_USD, 5);
    expect(estimate.inertCeilingMissions).toBe(1);
  });

  it('ignores a non-finite declared ceiling instead of poisoning the estimate', () => {
    const estimate = estimateMissionRunCost([{ maxIterations: 4, maxTotalCost: Number.NaN }]);
    expect(estimate.estimateUsd).toBeCloseTo(4 * SONNET_CACHE_USD, 5);
    expect(estimate.declaredCeilingUsd).toBe(0);
    expect(estimate.cappedMissions).toBe(0);
  });
});

// ── Ralph loop provider list ──────────────────────────────────
// mc validates --provider against a mirror of the loop's runtime registry.
describe('RALPH_LOOP_PROVIDERS', () => {
  const registryNames = (env: Record<string, string | undefined>) => {
    const script = [
      "const m = await import(process.argv[1]);",
      'await m.ensureProvidersRegistered();',
      'console.log(JSON.stringify(m.listProviders().sort()));',
    ].join('\n');
    const registry = pathToFileURL(resolve('tools/ralph-external/lib/provider-adapter.mjs')).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, registry], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, ...env },
    });
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout.trim().split('\n').at(-1)!);
  };

  it('matches the names the ralph loop registers', () => {
    expect([...RALPH_LOOP_PROVIDERS].sort()).toEqual(registryNames({ AIWG_MUSE_RALPH_ENABLED: undefined }));
  });

  it('drops muse exactly when the loop does', () => {
    const env = { AIWG_MUSE_RALPH_ENABLED: 'off' };
    expect(ralphLoopProviders(env).sort()).toEqual(registryNames(env));
    expect(ralphLoopProviders(env)).not.toContain('muse');
    expect(ralphLoopProviders({})).toContain('muse');
  });
});
