import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Capture real subprocess output without sandbox-sensitive stdio pipes. */
export function execFileWithCapture(file: string, args: string[], options: ExecFileSyncOptions): string {
  const scratch = mkdtempSync(path.join(tmpdir(), 'aiwg-test-capture-'));
  const stdout = path.join(scratch, 'stdout'), stderr = path.join(scratch, 'stderr');
  const outFd = openSync(stdout, 'w'), errFd = openSync(stderr, 'w');
  try {
    execFileSync(file, args, { ...options, timeout: options.timeout ?? 120_000, stdio: ['ignore', outFd, errFd] });
    return readFileSync(stdout, 'utf8');
  } catch (error) {
    const childError = error as Error & { stdout: string; stderr: string };
    childError.stdout = readFileSync(stdout, 'utf8');
    childError.stderr = readFileSync(stderr, 'utf8');
    childError.message += `\n${childError.stderr}`;
    throw error;
  } finally {
    closeSync(outFd);
    closeSync(errFd);
    rmSync(scratch, { recursive: true, force: true });
  }
}
