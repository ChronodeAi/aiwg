import type { ChildProcess } from 'node:child_process';

export function signalChild(
  child: Pick<ChildProcess, 'pid' | 'kill'> | null | undefined,
  signal?: NodeJS.Signals | number,
): boolean;
