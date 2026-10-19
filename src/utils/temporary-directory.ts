import { rmSync } from 'node:fs';

const directories = new Set<string>();
const removeAll = () => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
};
const onInterrupt = () => terminate('SIGINT', onInterrupt);
const onTerminate = () => terminate('SIGTERM', onTerminate);
function terminate(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void {
  removeAll();
  // Preserve an existing shutdown handler; otherwise restore default behavior.
  if (process.listenerCount(signal) === 1) {
    process.removeListener(signal, listener);
    process.kill(process.pid, signal);
  }
}

/** Own scratch through normal completion, explicit process.exit and termination.
 * SIGKILL cannot be handled; callers should still use finally for normal errors. */
export function trackTemporaryDirectory(directory: string): () => void {
  if (directories.size === 0) {
    process.once('exit', removeAll);
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
  }
  directories.add(directory);
  return () => {
    rmSync(directory, { recursive: true, force: true });
    directories.delete(directory);
    if (directories.size === 0) {
      process.removeListener('exit', removeAll);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
    }
  };
}
