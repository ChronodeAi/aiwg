/**
 * terminal-writeback — ADR-005 session terminalization: a session with ≥1
 * mission and every mission terminal goes to terminal state 'stopped'
 * exactly once; a session with any non-terminal mission does not.
 *
 * @source @tools/mc-bridge/liveness.mjs
 * @source @tools/mc-bridge/status-writer.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs module without bundled types
import { reconcileSessionLiveness } from '../../../tools/mc-bridge/liveness.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs module without bundled types
import { markSessionState } from '../../../tools/mc-bridge/status-writer.mjs';

describe('session terminalization via reconcileSessionLiveness', () => {
  let dir: string;
  let sessionPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'terminal-test-'));
    sessionPath = join(dir, 'session.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seedSession(state: string, missions: Array<Record<string, unknown>>): Promise<void> {
    await writeFile(
      sessionPath,
      JSON.stringify({ id: 'mc-test', state, missions, updatedAt: 'seed' }, null, 2),
    );
  }

  it('terminalizes an active session whose every mission is terminal', async () => {
    await seedSession('active', [
      { id: 'm-1', status: 'done' },
      { id: 'm-2', status: 'failed' },
      { id: 'm-3', status: 'aborted' },
    ]);

    const res = await reconcileSessionLiveness(sessionPath, { projectRoot: dir });

    expect(res.terminal).toBe(true);
    expect(res.terminalized).toBe(true);
    expect(res.reconciled).toEqual([]); // no mission changes — terminalization only
    const onDisk = JSON.parse(await readFile(sessionPath, 'utf-8'));
    expect(onDisk.state).toBe('stopped');
    expect(onDisk.updatedAt).not.toBe('seed');
  });

  it('tolerates completed/cancelled wire statuses as terminal (ADR wording)', async () => {
    await seedSession('active', [
      { id: 'm-1', status: 'completed' },
      { id: 'm-2', status: 'cancelled' },
    ]);

    const res = await reconcileSessionLiveness(sessionPath, { projectRoot: dir });

    expect(res.terminal).toBe(true);
    expect(res.terminalized).toBe(true);
    const onDisk = JSON.parse(await readFile(sessionPath, 'utf-8'));
    expect(onDisk.state).toBe('stopped');
  });

  it('is idempotent: a second run performs zero writes (updatedAt untouched)', async () => {
    await seedSession('active', [{ id: 'm-1', status: 'failed' }]);

    await reconcileSessionLiveness(sessionPath, { projectRoot: dir });
    const afterFirst = JSON.parse(await readFile(sessionPath, 'utf-8'));
    expect(afterFirst.state).toBe('stopped');

    const res = await reconcileSessionLiveness(sessionPath, { projectRoot: dir });
    expect(res.terminalized).toBe(false);
    const afterSecond = JSON.parse(await readFile(sessionPath, 'utf-8'));
    expect(afterSecond.updatedAt).toBe(afterFirst.updatedAt); // no write happened
  });

  it('does not terminalize while one mission is queued', async () => {
    await seedSession('active', [
      { id: 'm-1', status: 'done' },
      { id: 'm-2', status: 'queued' },
    ]);

    const res = await reconcileSessionLiveness(sessionPath, { projectRoot: dir });

    expect(res.terminal).toBe(false);
    expect(res.terminalized).toBe(false);
    const onDisk = JSON.parse(await readFile(sessionPath, 'utf-8'));
    expect(onDisk.state).toBe('active');
  });

  it('does not terminalize a session with zero missions', async () => {
    await seedSession('active', []);

    const res = await reconcileSessionLiveness(sessionPath, { projectRoot: dir });

    expect(res.terminal).toBe(false);
    expect(res.terminalized).toBe(false);
  });
});

describe('markSessionState', () => {
  let dir: string;
  let sessionPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'terminal-test-'));
    sessionPath = join(dir, 'session.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seedSession(state: string): Promise<void> {
    await writeFile(
      sessionPath,
      JSON.stringify({ id: 'mc-test', state, missions: [], updatedAt: 'seed' }),
    );
  }

  it('writes the terminal state through the same lock/atomic-write path', async () => {
    await seedSession('active');
    const res = await markSessionState(sessionPath, { state: 'stopped' });
    expect(res.outcome).toBe('updated');
    const onDisk = JSON.parse(await readFile(sessionPath, 'utf-8'));
    expect(onDisk.state).toBe('stopped');
    expect(onDisk.updatedAt).not.toBe('seed');
  });

  it('returns unchanged (no write) when already in the target state — never resurrects', async () => {
    await seedSession('stopped');
    const before = await readFile(sessionPath, 'utf-8');
    const res = await markSessionState(sessionPath, { state: 'stopped' });
    expect(res.outcome).toBe('unchanged');
    expect(await readFile(sessionPath, 'utf-8')).toBe(before);
  });

  it('returns stale (no write) when transitionFrom does not match the on-disk state', async () => {
    await seedSession('active');
    const res = await markSessionState(sessionPath, { state: 'stopped', transitionFrom: 'paused' });
    expect(res.outcome).toBe('stale');
    const onDisk = JSON.parse(await readFile(sessionPath, 'utf-8'));
    expect(onDisk.state).toBe('active'); // not clobbered
  });

  it('returns missing-session for an absent file', async () => {
    const res = await markSessionState(join(dir, 'absent.json'), { state: 'stopped' });
    expect(res.outcome).toBe('missing-session');
  });
});
