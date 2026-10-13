#!/usr/bin/env node
/**
 * Stub headless provider for UAT testing (#3062).
 *
 * Records its own argv (UAT_ARGV_LOG) and the full contents of its stdin
 * (UAT_STDIN_LOG, read to EOF), then exits 0. Used to prove which prompt
 * transport a headless `aiwg session --prompt`/`--prompt-file` launch
 * actually used: a stdin-transport provider's prompt never appears in the
 * recorded argv.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

const argvLog = process.env.UAT_ARGV_LOG;
if (argvLog) {
  mkdirSync(dirname(argvLog), { recursive: true });
  appendFileSync(argvLog, JSON.stringify(process.argv.slice(2)) + '\n');
}

const stdinLog = process.env.UAT_STDIN_LOG;
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  if (stdinLog) {
    mkdirSync(dirname(stdinLog), { recursive: true });
    writeFileSync(stdinLog, Buffer.concat(chunks).toString('utf8'));
  }
  process.stdout.write('stub-provider-stdin: ok\n');
  process.exit(0);
});
// If stdin is never piped at all (e.g. the provider is invoked with the
// prompt on argv instead), don't hang forever waiting for 'end'.
if (process.stdin.isTTY) {
  if (stdinLog) {
    mkdirSync(dirname(stdinLog), { recursive: true });
    writeFileSync(stdinLog, '');
  }
  process.stdout.write('stub-provider-stdin: ok (no stdin piped)\n');
  process.exit(0);
}
