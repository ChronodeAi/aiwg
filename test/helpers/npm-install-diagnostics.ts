// Preserve npm install failure details even when a timed-out child emits no output.
import type { SpawnSyncReturns } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

type InstallResult = Pick<SpawnSyncReturns<string>, 'status' | 'signal' | 'error' | 'stdout' | 'stderr'>;

export async function formatNpmInstallFailure(
  result: InstallResult,
  elapsedMs: number,
  logsDir: string,
): Promise<string> {
  const error = result.error as NodeJS.ErrnoException | undefined;
  const details = [
    `npm install failed after ${elapsedMs} ms: status=${result.status}, signal=${result.signal ?? 'none'}, ` +
      `error=${error ? `${error.name}: ${error.message} (code=${error.code ?? 'none'})` : 'none'}`,
    `stdout:\n${result.stdout || '(empty)'}`,
    `stderr:\n${result.stderr || '(empty)'}`,
  ];
  try {
    // npm names logs by ISO timestamp and a zero-padded rotation counter.
    const files = (await readdir(logsDir)).filter(name => /-debug-\d+\.log$/.test(name)).sort();
    const latest = files.at(-1);
    if (latest) {
      const filename = path.join(logsDir, latest);
      const contents = await readFile(filename, 'utf8');
      const tail = contents.trimEnd().split(/\r?\n/).slice(-80).join('\n');
      details.push(`npm debug log ${filename} (last 80 lines):\n${tail || '(empty)'}`);
    } else {
      details.push(`npm debug log unavailable: no debug logs in ${logsDir}`);
    }
  } catch (logError) {
    details.push(`npm debug log unavailable in ${logsDir}: ${String(logError)}`);
  }
  return details.join('\n');
}
