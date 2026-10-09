#!/usr/bin/env node
/**
 * Synthetic stand-in for `hermes chat --query-file - --oneshot --quiet`
 * (hermes 0.20.6) used by #2912 tests. It implements only the
 * source-evidenced quiet single-query contract read from the installed
 * `cli.py` `if quiet:` branch (hermes_cli, never run with a prompt):
 *
 *   - reads the query from stdin to EOF (never argv)
 *   - on success: prints the response text to stdout, nothing else; exit 0
 *   - on failure: prints nothing to stdout (an `Error: ...` line goes to
 *     stderr instead, mirroring `cli.py`'s `not response and ... error`
 *     branch), and exits 1 (`_exit_code = 1 if result.get("failed")`)
 *   - on partial-then-failed: prints the partial text to stdout (the real
 *     `elif response: print(response)` branch runs regardless of
 *     `failed`), but STILL exits 1 — this is the case the top-level `-z`
 *     path gets wrong (exit 0) and `chat --quiet` gets right (exit 1)
 *   - on budget-exhausted: mirrors `agent/conversation_loop.py:3902` exactly
 *     — a non-empty "Thinking Budget Exhausted" warning on stdout, NO
 *     `failed` key in the underlying result (not merely false — absent),
 *     so `_exit_code` stays 0. Exit 0, non-empty stdout, genuinely
 *     incomplete: this is the case `parseWorkerFinal`'s strict workerClaims
 *     parse must catch, since the exit code alone says "success".
 *   - `session_id: ...` goes to stderr only, never stdout
 *   - `--ignore-user-config` is accepted and otherwise ignored (the fixture
 *     has no config file to ignore)
 *
 * No network, model, credential or real Hermes code is involved. The
 * scenario and record path come from the JSON file named by
 * AIWG_FAKE_WORKER_CONFIG ({ scenario, recordPath }); without it the
 * success scenario runs and nothing is recorded.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const config = process.env.AIWG_FAKE_WORKER_CONFIG
  ? JSON.parse(readFileSync(process.env.AIWG_FAKE_WORKER_CONFIG, 'utf8')) : {};
const scenario = config.scenario ?? 'success';
const args = process.argv.slice(2);

if (!args.length || ['-h', '--help'].includes(args[0])) {
  process.stdout.write('usage: hermes chat [-h] [-q QUERY | --query-file PATH] [--oneshot] [-m MODEL] [--reasoning LEVEL] [-Q] ... (synthetic fixture)\n');
  process.exit(0);
}
if (args[0] === '--version' || args[0] === '-V') {
  process.stdout.write('Hermes Agent v0.20.6 (synthetic fixture)\n');
  process.exit(0);
}
if (args[0] !== 'chat') { process.stderr.write(`hermes: unrecognized command: ${args[0]}\n`); process.exit(2); }

let queryFile = null, oneshot = false, quiet = false, model = null, reasoning = null;
for (let index = 1; index < args.length;) {
  const arg = args[index];
  if (arg === '--query-file') { queryFile = args[index + 1]; index += 2; }
  else if (arg === '--oneshot') { oneshot = true; index += 1; }
  else if (arg === '-Q' || arg === '--quiet') { quiet = true; index += 1; }
  else if (arg === '-m' || arg === '--model') { model = args[index + 1]; index += 2; }
  else if (arg === '--reasoning') { reasoning = args[index + 1]; index += 2; }
  else if (arg === '--ignore-user-config' || arg === '--ignore-rules') { index += 1; }
  else if (arg === '--source') { index += 2; }
  else { process.stderr.write(`hermes chat: unrecognized arguments: ${arg}\n`); process.exit(2); }
}
if (queryFile !== '-') { process.stderr.write('hermes chat: this fixture only implements --query-file -\n'); process.exit(2); }
if (!oneshot || !quiet) { process.stderr.write('hermes chat: this fixture only implements --oneshot --quiet\n'); process.exit(2); }

// `--query-file -` reads stdin to EOF (hermes_cli/main.py: args.query = sys.stdin.read()).
const chunks = [];
await new Promise(resolve => {
  process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('end', resolve);
  process.stdin.on('error', resolve);
});
const query = Buffer.concat(chunks).toString('utf8');

if (config.recordPath) {
  writeFileSync(config.recordPath, JSON.stringify({
    argv: process.argv.slice(2), cwd: process.cwd(), envNames: Object.keys(process.env).sort(),
    query, model, reasoning, pid: process.pid,
  }), { mode: 0o600 });
}

if (scenario === 'hang') {
  // Silent hang after reading stdin, no stdout write.
  await new Promise(() => {});
}

if (scenario === 'no-response-failed') {
  // Empty response + failed: nothing on stdout, error to stderr, exit 1.
  process.stderr.write('Error: AuthenticationError: invalid api key\n');
  process.stderr.write('\nsession_id: fixture-session\n');
  process.exit(1);
}

if (scenario === 'partial-then-failed') {
  // The critical invariant under test: partial text is still printed to
  // stdout (the real `elif response: print(response)` branch does not
  // check `failed`), but the exit code is still 1 — unlike the old `-z`
  // path, this CLI's own exit code already tells the truth.
  process.stdout.write(`partial reply before failure (${query.length} chars)\n`);
  process.stderr.write('\nsession_id: fixture-session\n');
  process.exit(1);
}

if (scenario === 'budget-exhausted') {
  // agent/conversation_loop.py:3902 verbatim shape: completed:false,
  // partial:true, an error string, and NO "failed" key at all. cli.py's
  // quiet branch still prints the non-empty final_response to stdout and
  // _exit_code stays 0 because result.get("failed") is None.
  process.stdout.write('⚠️ **Thinking Budget Exhausted**\n\nThe model used all its output tokens on reasoning and had none left for the actual response.\n');
  process.stderr.write('\nsession_id: fixture-session\n');
  process.exit(0);
}

// success: the brief instructs the worker to respond with a workerClaims
// JSON document (the model's own output, not a CLI event); the fixture
// stands in for that instructed response directly.
process.stdout.write(`${JSON.stringify({ version: 1, status: 'completed', summary: `synthetic reply (${query.length} chars)`,
  claims: [], artifacts: [], checks: [], limitations: [] })}\n`);
process.stderr.write('\nsession_id: fixture-session\n');
process.exit(0);
