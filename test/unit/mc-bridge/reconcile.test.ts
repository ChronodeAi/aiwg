/**
 * reconcile — ADR-005 reconciled-on-read projection: dead loops project as
 * `failed` with a `loop died <timestamp>` reason, written back through the
 * status-writer mutex/atomic path with transitionFrom guards.
 *
 * @source @tools/mc-bridge/liveness.mjs
 * @source @tools/mc-bridge/status-writer.mjs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs module without bundled types
import { reconcileSessionLiveness } from '../../../tools/mc-bridge/liveness.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs module without bundled types
import { applyStatusUpdate } from '../../../tools/mc-bridge/status-writer.mjs';

describe('reconcileSessionLiveness', () => {
  let dir: string;
  let sessionPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reconcile-test-'));
    sessionPath = join(dir, 'session.json');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function writeHeartbeat(loopId: string, record: Record<string, unknown>): Promise<void> {
    const hbDir = join(dir, '.aiwg', 'ralph', 'heartbeats');
    await mkdir(hbDir, { recursive: true });
    await writeFile(join(hbDir, `${loopId}.json`), JSON.stringify(record));
  }

  async function seedSession(missions: Array<Record<string, unknown>>): Promise<void> {
    await writeFile(
      sessionPath,
      JSON.stringify({ id: 'mc-test', state: 'active', missions, updatedAt: 'seed' }, null, 2),
    );
  }

  async function readBack(): Promise<{ missions: Array<Record<string, unknown>>; state: string; updatedAt: string }> {
    return JSON.parse(await readFile(sessionPath, 'utf-8'));
  }

  it('projects a stale-heartbeat running mission as failed and preserves a live one', async () => {
    await writeHeartbeat('loop-dead', { timestamp: Date.now() - 61_000, iteration: 4, status: 'running' });
    await writeHeartbeat('loop-live', { timestamp: Date.now(), iteration: 5, status: 'running' });
    await seedSession([
      { id: 'm-1', status: 'running', ralphLoopId: 'loop-dead' },
      { id: 'm-2', status: 'running', ralphLoopId: 'loop-live' },
    ]);

    const res = await reconcileSessionLiveness(sessionPath, { projectRoot: dir });

    expect(res.reconciled).toEqual(['m-1']);
    expect(res.terminal).toBe(false);
    expect(res.transitions).toHaveLength(1);
    expect(res.transitions[0].from).toBe('running');
    expect(res.transitions[0].failureReason).toMatch(/^loop died \d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

    const onDisk = await readBack();
    expect(onDisk.missions[0].status).toBe('failed');
    expect(onDisk.missions[0].failureReason).toMatch(/^loop died \d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(onDisk.missions[0].reconciledAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(onDisk.missions[1].status).toBe('running'); // live loop untouched
    expect(onDisk.missions[1].failureReason).toBeUndefined();
    expect(onDisk.updatedAt).not.toBe('seed');
  });

  it('kills a running mission with a fresh heartbeat but a dead PID (AND predicate)', async () => {
    await writeHeartbeat('loop-x', { timestamp: Date.now(), iteration: 2, status: 'running' });
    await seedSession([{ id: 'm-1', status: 'running', ralphLoopId: 'loop-x', ralphPid: 424_242 }]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });

    const res = await reconcileSessionLiveness(sessionPath, { projectRoot: dir });

    expect(res.reconciled).toEqual(['m-1']);
    const onDisk = await readBack();
    expect(onDisk.missions[0].status).toBe('failed');
  });

  it('applies multiple dead missions in one batched write', async () => {
    await writeHeartbeat('loop-a', { timestamp: Date.now() - 120_000 });
    await writeHeartbeat('loop-b', { timestamp: Date.now() - 130_000 });
    await seedSession([
      { id: 'm-1', status: 'running', ralphLoopId: 'loop-a' },
      { id: 'm-2', status: 'running', ralphLoopId: 'loop-b' },
    ]);

    const res = await reconcileSessionLiveness(sessionPath, { projectRoot: dir });

    expect(res.reconciled).toEqual(['m-1', 'm-2']);
    const onDisk = await readBack();
    expect(onDisk.missions.map(m => m.status)).toEqual(['failed', 'failed']);
  });

  it('dryRun reports transitions without writing anything', async () => {
    await writeHeartbeat('loop-dead', { timestamp: Date.now() - 61_000 });
    await seedSession([{ id: 'm-1', status: 'running', ralphLoopId: 'loop-dead' }]);
    const before = await readFile(sessionPath, 'utf-8');

    const res = await reconcileSessionLiveness(sessionPath, { projectRoot: dir, dryRun: true });

    expect(res.dryRun).toBe(true);
    expect(res.reconciled).toEqual(['m-1']);
    expect(res.transitions[0].to).toBe('failed');
    expect(await readFile(sessionPath, 'utf-8')).toBe(before); // zero writes
  });

  it('never overwrites a fresher concurrent write (transitionFrom loses cleanly)', async () => {
    await writeHeartbeat('loop-dead', { timestamp: Date.now() - 61_000 });
    await seedSession([{ id: 'm-1', status: 'running', ralphLoopId: 'loop-dead' }]);
    // A live dispatch event handler moves the mission first.
    await applyStatusUpdate(sessionPath, { missionId: 'm-1', status: 'assigned' });

    const res = await reconcileSessionLiveness(sessionPath, { projectRoot: dir });

    expect(res.reconciled).toEqual([]); // reconcile lost via transitionFrom guard
    const onDisk = await readBack();
    expect(onDisk.missions[0].status).toBe('assigned'); // fresher write preserved
    expect(onDisk.missions[0].failureReason).toBeUndefined();
  });

  it('serializes with a concurrent dispatch update without losing either write', async () => {
    await writeHeartbeat('loop-dead', { timestamp: Date.now() - 61_000 });
    await seedSession([{ id: 'm-1', status: 'running', ralphLoopId: 'loop-dead' }]);

    const [, reconcileRes] = await Promise.all([
      applyStatusUpdate(sessionPath, { missionId: 'm-1', status: 'assigned' }),
      reconcileSessionLiveness(sessionPath, { projectRoot: dir }),
    ]);

    const onDisk = await readBack(); // file must parse — no interleaved corruption
    const finalStatus = onDisk.missions[0].status;
    expect(['assigned', 'failed']).toContain(finalStatus);
    if (finalStatus === 'failed') {
      expect(reconcileRes.reconciled).toEqual(['m-1']);
    } else {
      expect(reconcileRes.reconciled).toEqual([]); // reconcile hit the guard and lost cleanly
    }
  });

  it('never resurrects an already-terminal mission, but terminalizes the session', async () => {
    await seedSession([{ id: 'm-1', status: 'failed', failureReason: 'boom' }]);

    const res = await reconcileSessionLiveness(sessionPath, { projectRoot: dir });

    expect(res.reconciled).toEqual([]); // mission untouched — no resurrection, no rewrite
    const onDisk = await readBack();
    expect(onDisk.missions[0].status).toBe('failed');
    expect(onDisk.missions[0].failureReason).toBe('boom');
    // All missions terminal + session active → the ADR-mandated write-back.
    expect(res.terminal).toBe(true);
    expect(res.terminalized).toBe(true);
    expect(onDisk.state).toBe('stopped');
  });

  it('never touches queued or paused missions (no live-loop expectation)', async () => {
    await seedSession([
      { id: 'm-1', status: 'queued' },
      { id: 'm-2', status: 'paused' },
    ]);
    const before = await readFile(sessionPath, 'utf-8');

    const res = await reconcileSessionLiveness(sessionPath, { projectRoot: dir });

    expect(res.reconciled).toEqual([]);
    expect(await readFile(sessionPath, 'utf-8')).toBe(before);
  });

  it('reports missing-session for an absent session.json', async () => {
    const res = await reconcileSessionLiveness(join(dir, 'absent.json'), { projectRoot: dir });
    expect(res.outcome).toBe('missing-session');
    expect(res.reconciled).toEqual([]);
  });
});
