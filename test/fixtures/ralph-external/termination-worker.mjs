// Offline worker with optional surviving same-group or setsid descendant.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (process.argv[2] === 'descendant') {
  setTimeout(() => {}, 15000);
} else {
  const [mode, final, childPid] = process.argv.slice(2);
  writeFileSync(`${childPid}.env`, process.env.AIWG_WORKER_INVOCATION_ID ?? 'missing');
  if (mode === 'live' || mode === 'escaped') {
    const child = spawn(process.execPath, [import.meta.filename, 'descendant'], {
      stdio: 'ignore', detached: mode === 'escaped' });
    writeFileSync(childPid, String(child.pid));
    child.unref();
  }
  // Leave time for the launcher's kernel identity capture, independent of logs.
  await new Promise(resolve => setTimeout(resolve, 250));
  writeFileSync(final, JSON.stringify({ summary: 'Synthetic termination result.' }));
}
