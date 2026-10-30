// Stop a fake CLI after its TERM handler is ready, then enforce the existing grace period.
import type { ChildProcess } from 'node:child_process';
import { TERM_READY } from '../fixtures/providers/ignore-term.mjs';

export { TERM_READY };

export function termAfterReady(child: ChildProcess) {
  let output = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onData = (chunk: Buffer) => {
    output += chunk.toString();
    if (!output.includes(TERM_READY)) return;
    child.stdout!.off('data', onData);
    child.kill('SIGTERM');
    timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 500);
  };
  const cleanup = () => {
    clearTimeout(timer);
    child.stdout!.off('data', onData);
  };
  child.stdout!.on('data', onData);
  child.once('close', cleanup);
  child.once('error', cleanup);
}
