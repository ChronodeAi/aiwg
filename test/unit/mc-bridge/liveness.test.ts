/**
 * liveness — ADR-005 two-signal loop liveness predicate.
 *
 * The predicate is the AND of heartbeat age (threshold expressed as N × the
 * 30s heartbeat interval, default N=2 → 60 000ms, aligned with
 * process-monitor.mjs:43) and a kill(pid, 0) existence check when a PID is
 * known. Missing heartbeat record → not live (fail toward truth).
 *
 * @source @tools/mc-bridge/liveness.mjs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs module without bundled types
import {
  heartbeatPath,
  readHeartbeat,
  isLoopLive,
  HEARTBEAT_INTERVAL_MS,
  DEFAULT_STALE_MULTIPLIER,
  DEFAULT_HEARTBEAT_STALE_MS,
} from '../../../tools/mc-bridge/liveness.mjs';

describe('heartbeatPath / readHeartbeat', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'liveness-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves .aiwg/ralph/heartbeats/<loopId>.json (process-monitor.mjs:264 convention)', () => {
    expect(heartbeatPath(dir, 'loop-1')).toBe(join(dir, '.aiwg', 'ralph', 'heartbeats', 'loop-1.json'));
  });

  it('parses the heartbeat record fields', async () => {
    const hbDir = join(dir, '.aiwg', 'ralph', 'heartbeats');
    await mkdir(hbDir, { recursive: true });
    await writeFile(
      join(hbDir, 'loop-1.json'),
      JSON.stringify({ loopId: 'loop-1', timestamp: 1_234, iteration: 3, status: 'running' }),
    );
    const hb = await readHeartbeat(dir, 'loop-1');
    expect(hb).toMatchObject({ timestamp: 1_234, iteration: 3, status: 'running' });
  });

  it('returns null for a missing record (fail toward truth)', async () => {
    expect(await readHeartbeat(dir, 'absent')).toBeNull();
  });

  it('returns null for an unreadable (corrupt) record', async () => {
    const hbDir = join(dir, '.aiwg', 'ralph', 'heartbeats');
    await mkdir(hbDir, { recursive: true });
    await writeFile(join(hbDir, 'loop-bad.json'), '{not json');
    expect(await readHeartbeat(dir, 'loop-bad')).toBeNull();
  });
});

describe('isLoopLive', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'liveness-test-'));
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

  it('threshold default is N×30s = 60000ms, aligned with process-monitor staleThresholdMs', () => {
    expect(DEFAULT_STALE_MULTIPLIER).toBe(2);
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(DEFAULT_HEARTBEAT_STALE_MS).toBe(60_000);
  });

  it('fresh heartbeat + live PID → true', async () => {
    await writeHeartbeat('l1', { timestamp: Date.now(), iteration: 1, status: 'running' });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(await isLoopLive({ loopId: 'l1', pid: 424_242 }, { projectRoot: dir })).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(424_242, 0);
  });

  it('fresh heartbeat, no PID → predicate rests on heartbeat age alone', async () => {
    await writeHeartbeat('l2', { timestamp: Date.now(), iteration: 1, status: 'running' });
    expect(await isLoopLive({ loopId: 'l2' }, { projectRoot: dir })).toBe(true);
  });

  it('stale heartbeat → false even when a PID answers (a recycled PID cannot rescue)', async () => {
    await writeHeartbeat('l3', { timestamp: Date.now() - 61_000, iteration: 1, status: 'running' });
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(await isLoopLive({ loopId: 'l3', pid: 424_242 }, { projectRoot: dir })).toBe(false);
  });

  it('missing heartbeat file → false', async () => {
    expect(await isLoopLive({ loopId: 'absent', pid: 424_242 }, { projectRoot: dir })).toBe(false);
  });

  it('heartbeat age exactly at the threshold is still fresh (≤)', async () => {
    const ts = Date.now();
    await writeHeartbeat('l4', { timestamp: ts });
    expect(await isLoopLive({ loopId: 'l4' }, { projectRoot: dir, now: ts + 60_000 })).toBe(true);
    expect(await isLoopLive({ loopId: 'l4' }, { projectRoot: dir, now: ts + 60_001 })).toBe(false);
  });

  it('record without a timestamp falls back to the heartbeat file mtime', async () => {
    await writeHeartbeat('l5', { iteration: 1 }); // parsed, but no timestamp field
    expect(await isLoopLive({ loopId: 'l5' }, { projectRoot: dir })).toBe(true);
  });

  it('ESRCH on the PID check → dead', async () => {
    await writeHeartbeat('l6', { timestamp: Date.now() });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });
    expect(await isLoopLive({ loopId: 'l6', pid: 424_242 }, { projectRoot: dir })).toBe(false);
  });

  it('EPERM on the PID check → alive (process exists, owned by another user)', async () => {
    await writeHeartbeat('l7', { timestamp: Date.now() });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    });
    expect(await isLoopLive({ loopId: 'l7', pid: 1 }, { projectRoot: dir })).toBe(true);
  });

  it('no loopId and no PID → no liveness evidence → false', async () => {
    expect(await isLoopLive({}, { projectRoot: dir })).toBe(false);
  });

  it('PID known but no loopId → dead (heartbeat age is the required signal)', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(await isLoopLive({ pid: 424_242 }, { projectRoot: dir })).toBe(false);
  });

  it('staleMultiplier N scales the threshold (N × 30s)', async () => {
    await writeHeartbeat('l8', { timestamp: Date.now() - 100_000 }); // stale at N=2, fresh at N=4 (120s)
    expect(await isLoopLive({ loopId: 'l8' }, { projectRoot: dir, staleMultiplier: 2 })).toBe(false);
    expect(await isLoopLive({ loopId: 'l8' }, { projectRoot: dir, staleMultiplier: 4 })).toBe(true);
  });
});
