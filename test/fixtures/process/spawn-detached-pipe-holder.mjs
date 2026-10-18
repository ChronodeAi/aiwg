// Fixture child process for bounded-child-process tests (#3062): spawns a
// detached grandchild that inherits this process's stdout (a pipe, when
// launched through the bounded helper's default stdio) and ignores
// SIGTERM, then this direct-child process exits successfully right away.
//
// Demonstrates that a surviving, pipe-holding descendant can still trigger
// `ETIMEDOUT` on a bounded call long after the direct child it came from
// has exited on its own — because the call is still waiting for that pipe
// to reach EOF, which only happens once every holder of its write end
// (the direct child *and* the grandchild) has closed it.
//
// Writes the grandchild's pid to the file named in argv[2] so the test can
// clean it up: it is `detached` and `unref()`'d and will not exit on its
// own otherwise.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const pidFile = process.argv[2];

const grandchild = spawn(process.execPath, [
  '-e',
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
], {
  detached: true,
  stdio: ['ignore', 'inherit', 'ignore'],
});
grandchild.unref();

if (pidFile) writeFileSync(pidFile, String(grandchild.pid));

process.exit(0);
