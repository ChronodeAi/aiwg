// Exercise readiness and escalation ordering without relying on child startup speed.
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { termAfterReady, TERM_READY } from '../../helpers/term-escalation.js';

function fixture() {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), kill: vi.fn(), exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  });
  termAfterReady(child as unknown as ChildProcess);
  return child;
}

afterEach(() => vi.useRealTimers());

describe('fake CLI TERM/KILL readiness', () => {
  it('waits past the former startup delay and for the complete, chunked readiness line', () => {
    const child = fixture();
    vi.advanceTimersByTime(1_000);
    child.stdout.write('unrelated output\n');
    child.stdout.write(TERM_READY.slice(0, -1));
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.write(TERM_READY.slice(-1));
    expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
    child.stdout.write(TERM_READY); // Repeated readiness cannot start another stop.
    vi.advanceTimersByTime(499);
    expect(child.kill).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    child.emit('close');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['close', 'error'])('cleans up the readiness listener and pending escalation on %s', event => {
    const child = fixture();
    child.stdout.write(TERM_READY);
    child.emit(event);
    vi.advanceTimersByTime(500);
    expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not KILL a child that has already exited during the grace period', () => {
    const child = fixture();
    child.stdout.write(TERM_READY);
    child.exitCode = 0;
    vi.advanceTimersByTime(500);
    expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
    child.emit('close');
  });
});
