/**
 * Housekeeper daemon lifecycle helpers (epic #3353 slice B5).
 *
 * Mirrors the pid/lock/heartbeat/state/socket paths of
 * `tools/daemon/daemon-main.mjs` so `aiwg housekeeper start|stop|status`
 * serializes against the same single-instance lock: a second `start`
 * fails clearly, and `stop` cleans up exactly the files the daemon owns.
 * All process signalling of owned ChildProcess handles goes through
 * `signalChild`; pid-based stop uses `process.kill` (no ChildProcess).
 */

import fs from 'node:fs';
import path from 'node:path';
import { signalChild } from '../process/signal-child.mjs';
import type { ChildProcess } from 'node:child_process';

export interface DaemonPaths {
  pidFile: string;
  lockFile: string;
  heartbeatFile: string;
  stateFile: string;
  socketPath: string;
  logFile: string;
  taskStorePath: string;
  daemonScript: string;
}

/** Same relative layout as DaemonMain; resolved against the caller cwd. */
export function daemonPaths(cwd: string, frameworkRoot: string): DaemonPaths {
  return {
    pidFile: path.join(cwd, '.aiwg', 'daemon.pid'),
    lockFile: path.join(cwd, '.aiwg', 'daemon', '.lock'),
    heartbeatFile: path.join(cwd, '.aiwg', 'daemon', 'heartbeat'),
    stateFile: path.join(cwd, '.aiwg', 'daemon', 'state.json'),
    socketPath: path.join(cwd, '.aiwg', 'daemon', 'daemon.sock'),
    logFile: path.join(cwd, '.aiwg', 'daemon', 'daemon.log'),
    taskStorePath: path.join(cwd, '.aiwg', 'daemon', 'tasks.json'),
    daemonScript: path.join(frameworkRoot, 'tools', 'daemon', 'daemon-main.mjs'),
  };
}

export function readPidFile(pidFile: string): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(pidFile, 'utf8').trim();
  } catch {
    return null;
  }
  const pid = Number.parseInt(raw, 10);
  return Number.isSafeInteger(pid) && pid > 0 && String(pid) === raw ? pid : null;
}

export type KillFn = (pid: number, signal: NodeJS.Signals) => void;

export function defaultKill(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = no such process. Any other error (e.g. EPERM) means a
    // process exists that we may not signal — treat as alive.
    if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') return false;
    return true;
  }
}

export interface RunningState {
  running: boolean;
  pid: number | null;
  stale: boolean;
}

/**
 * Report whether a daemon owns the pid file. A pid file pointing at a
 * dead process is stale (safe to overwrite after cleanup); a live one
 * blocks `start`.
 */
export function describeRunning(pidFile: string): RunningState {
  const pid = readPidFile(pidFile);
  if (pid === null) return { running: false, pid: null, stale: false };
  if (isPidAlive(pid)) return { running: true, pid, stale: false };
  return { running: false, pid, stale: true };
}

export function removeLifecycleFiles(paths: Pick<DaemonPaths, 'pidFile' | 'lockFile'>): void {
  for (const file of [paths.pidFile, paths.lockFile]) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
  }
}

export interface StopOptions {
  paths: DaemonPaths;
  kill?: KillFn;
  /** Grace period before SIGKILL, in ms. Default 10_000. */
  timeoutMs?: number;
  /** Liveness poll interval in ms. Default 200. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

export type StopOutcome =
  | { outcome: 'not-running' }
  | { outcome: 'stopped'; pid: number; forced: boolean }
  | { outcome: 'stale-cleaned'; pid: number };

/**
 * Stop the daemon gracefully (SIGTERM, poll, then SIGKILL on timeout),
 * then release the pid/lock files. Never throws for absent files.
 */
export async function stopDaemon(options: StopOptions): Promise<StopOutcome> {
  const { paths, kill = defaultKill, timeoutMs = 10_000, pollMs = 200 } = options;
  const sleep = options.sleep ?? defaultSleep;
  const state = describeRunning(paths.pidFile);
  if (state.pid === null) return { outcome: 'not-running' };
  if (!state.running) {
    removeLifecycleFiles(paths);
    return { outcome: 'stale-cleaned', pid: state.pid };
  }
  const pid = state.pid;
  try {
    kill(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') {
      removeLifecycleFiles(paths);
      return { outcome: 'stale-cleaned', pid };
    }
    throw error;
  }
  const deadline = Date.now() + timeoutMs;
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }
  let forced = false;
  if (isPidAlive(pid)) {
    try {
      kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') throw error;
    }
    forced = true;
    const killDeadline = Date.now() + Math.min(timeoutMs, 5000);
    while (isPidAlive(pid) && Date.now() < killDeadline) {
      await sleep(pollMs);
    }
  }
  removeLifecycleFiles(paths);
  return { outcome: 'stopped', pid, forced };
}

/** Forward a terminal signal to an owned foreground child. */
export function forwardSignalToChild(child: ChildProcess, signal: NodeJS.Signals): void {
  signalChild(child, signal);
}

/**
 * Poll until `predicate` is true or the deadline passes. Returns true on
 * success; used by `start` to wait for the pid file without fixed sleeps.
 */
export async function pollUntil(
  predicate: () => boolean,
  options: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const { timeoutMs = 10_000, pollMs = 200 } = options;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}
