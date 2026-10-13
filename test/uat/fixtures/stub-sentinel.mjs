#!/usr/bin/env node
/**
 * Sentinel stub for UAT testing (#3062).
 *
 * Writes one line (its own argv) to UAT_SENTINEL_LOG if invoked at all,
 * then exits 0. Used to prove a forbidden interactive program (an editor,
 * a browser opener) was never spawned by a headless run: the test asserts
 * the sentinel log was never created.
 */
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const log = process.env.UAT_SENTINEL_LOG;
if (log) {
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\n');
}
process.exit(0);
