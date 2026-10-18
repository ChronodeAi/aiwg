#!/usr/bin/env node
/**
 * "Parent exits first" fixture for the UAT supervisor's own test (#3062
 * second review, finding 11).
 *
 * Spawns a grandchild (not detached — same process group as this
 * process) that would otherwise run forever, writes its pid to
 * PARENT_EXITS_FIRST_PID_FILE, then exits immediately and cleanly itself
 * (exit code 0), *without* waiting for the grandchild. Proves the
 * supervisor kills a surviving descendant even when the direct child's
 * own exit is fast and ordinary — not just on the hang-guard timeout
 * path.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const pidFile = process.env.PARENT_EXITS_FIRST_PID_FILE;
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
  stdio: 'ignore',
  detached: false,
});
writeFileSync(pidFile, String(grandchild.pid));
process.exit(0);
