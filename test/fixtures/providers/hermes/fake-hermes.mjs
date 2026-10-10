#!/usr/bin/env node
/**
 * Synthetic stand-in for `hermes chat --query-file - --oneshot --quiet`
 * (hermes 0.21.6, re-verified 2026-10-10 against the per-user install
 * `~/.hermes/hermes-agent`; the root `/usr/local/lib/hermes-agent` 0.20.6
 * copy is stale and never cited) used by #2912 tests. It implements only
 * the source-evidenced quiet single-query contract read from
 * `hermes_cli/cli_single_query.py::_run_quiet_single_query` /
 * `_single_query_exit_code` (never run with a prompt):
 *
 *   - reads the query from stdin to EOF (never argv)
 *   - on success: prints the response text to stdout, nothing else; exit 0
 *   - on failure: prints nothing to stdout (an `Error: ...` line goes to
 *     stderr instead, mirroring `cli_single_query.py`'s
 *     `not response and ... error` branch), and exits 1
 *   - on partial-then-failed: prints the partial text to stdout (the real
 *     `elif response: print(response)` branch runs regardless of
 *     `failed`), but STILL exits 1 — this is the case the top-level `-z`
 *     path gets wrong (exit 0) and `chat --quiet` gets right (exit 1)
 *   - on budget-exhausted: historically (hermes 0.20.6) mirrored
 *     `agent/conversation_loop.py:3902` — a non-empty "Thinking Budget
 *     Exhausted" warning on stdout, NO `failed` key in the underlying
 *     result, exit 0 regardless. On 0.21.6 this exact case now correctly
 *     exits 1 (`_single_query_exit_code` checks `partial`/`completed is
 *     False` too, `agent/turn_truncation.py:95-180`'s `partial_result()`),
 *     so this scenario is kept as a defense-in-depth regression test of
 *     `parseWorkerFinal`'s strict workerClaims parse, independent of
 *     whatever the CLI's own exit code says.
 *   - `session_id: ...` goes to stderr only, never stdout
 *   - `--ignore-user-config` is accepted and otherwise ignored (the fixture
 *     has no config file to ignore)
 *   - `--provider` is REQUIRED and rejects the literal `auto`: this mirrors
 *     TWO live conductor smoke runs reproducing the identical failure/fix —
 *     0.20.6 on 2026-10-09 and 0.21.6 on 2026-10-10 — where an omitted
 *     `--provider` under `--ignore-user-config` resolved to
 *     `resolve_requested_provider()`'s `"auto"` fallback
 *     (`hermes_cli/runtime_provider.py:490-499`) and failed with "No
 *     inference provider configured"; `--provider openrouter` succeeded on
 *     both. A missing or `auto` provider here fails the same way, on
 *     stderr, exit 1.
 *   - `diagnostic-then-success` / `diagnostic-garbage-preamble` /
 *     `diagnostic-only` scenarios reproduce a HISTORICAL (0.20.6-only)
 *     finding: that build's `_ensure_tirith_security` (`cli.py:8805-8822`
 *     in that build) could print a `_cprint`-rendered startup diagnostic
 *     line to stdout even with `--quiet --oneshot`. The tirith scanner was
 *     removed entirely by 0.21.6 (`hermes_cli/config_migrations.py:686-702`)
 *     and the 2026-10-10 smoke run confirmed the line no longer appears;
 *     these scenarios are kept as defensive/forward-compatible regression
 *     tests of the stripper, not a live 0.21.6 reproduction.
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
  process.stdout.write('usage: hermes chat [-h] [-q QUERY | --query-file PATH] [--oneshot] [-m MODEL] [--provider PROVIDER] [--reasoning LEVEL] [-Q] ... (synthetic fixture)\n');
  process.exit(0);
}
if (args[0] === '--version' || args[0] === '-V') {
  process.stdout.write('Hermes Agent v0.21.6+387.gdce1e9b (2026.9.24) · stable · local dce1e9b37581 (synthetic fixture)\n');
  process.exit(0);
}
if (args[0] !== 'chat') { process.stderr.write(`hermes: unrecognized command: ${args[0]}\n`); process.exit(2); }

let queryFile = null, oneshot = false, quiet = false, model = null, reasoning = null, provider = null;
for (let index = 1; index < args.length;) {
  const arg = args[index];
  if (arg === '--query-file') { queryFile = args[index + 1]; index += 2; }
  else if (arg === '--oneshot') { oneshot = true; index += 1; }
  else if (arg === '-Q' || arg === '--quiet') { quiet = true; index += 1; }
  else if (arg === '-m' || arg === '--model') { model = args[index + 1]; index += 2; }
  else if (arg === '--reasoning') { reasoning = args[index + 1]; index += 2; }
  else if (arg === '--provider') { provider = args[index + 1]; index += 2; }
  else if (arg === '--ignore-user-config' || arg === '--ignore-rules') { index += 1; }
  else if (arg === '--source') { index += 2; }
  else { process.stderr.write(`hermes chat: unrecognized arguments: ${arg}\n`); process.exit(2); }
}
if (queryFile !== '-') { process.stderr.write('hermes chat: this fixture only implements --query-file -\n'); process.exit(2); }
if (!oneshot || !quiet) { process.stderr.write('hermes chat: this fixture only implements --oneshot --quiet\n'); process.exit(2); }

// `--query-file -` reads stdin to EOF (hermes_cli/main.py: args.query = sys.stdin.read()),
// unconditionally and before provider resolution -- drain it here too so a
// missing/"auto" --provider still matches the real CLI's observed shape
// (stdin consumed, then the provider failure below).
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
    query, model, reasoning, provider, pid: process.pid,
  }), { mode: 0o600 });
}

// Mirrors resolve_requested_provider()'s "auto" fallback and the live
// smoke-run failure when no inference provider can be resolved under
// --ignore-user-config (runtime_provider.py:647-663; no response printed
// to stdout, error + session_id to stderr, exit 1 -- same shape as the
// 'no-response-failed' scenario below).
if (!provider || provider === 'auto') {
  process.stderr.write('Error: No inference provider configured\n');
  process.stderr.write('\nsession_id: fixture-session\n');
  process.exit(1);
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

// The verbatim `_ensure_tirith_security` diagnostic line (cli.py:8805-8822),
// `_DIM`/`_RST` ANSI-wrapped exactly as `_cprint` renders it
// (cli.py:3094,3520), confirmed by the live conductor smoke run.
const TIRITH_DIAGNOSTIC = '  \x1b[2;3m⚠ tirith security scanner enabled but not available — command scanning will use pattern matching only\x1b[0m\n';
const CLAIMS = JSON.stringify({ version: 1, status: 'completed', summary: `synthetic reply (${query.length} chars)`,
  claims: [], artifacts: [], checks: [], limitations: [] });

if (scenario === 'diagnostic-then-success') {
  // A known startup diagnostic precedes a genuinely valid final: exit 0,
  // stdout carries both. parseWorkerFinal must strip only the diagnostic
  // line and still accept the final beneath it.
  process.stdout.write(`${TIRITH_DIAGNOSTIC}${CLAIMS}\n`);
  process.stderr.write('\nsession_id: fixture-session\n');
  process.exit(0);
}

if (scenario === 'diagnostic-garbage-preamble') {
  // Unrecognized preamble (no leading "⚠" marker) ahead of an otherwise
  // valid final: must NOT be stripped, so the strict parse still fails.
  process.stdout.write(`unexpected preamble text\n${CLAIMS}\n`);
  process.stderr.write('\nsession_id: fixture-session\n');
  process.exit(0);
}

if (scenario === 'diagnostic-only') {
  // Only the diagnostic prints; no final at all. Stripping it must leave
  // nothing for the strict parse to accept.
  process.stdout.write(TIRITH_DIAGNOSTIC);
  process.stderr.write('\nsession_id: fixture-session\n');
  process.exit(0);
}

// success: the brief instructs the worker to respond with a workerClaims
// JSON document (the model's own output, not a CLI event); the fixture
// stands in for that instructed response directly.
process.stdout.write(`${CLAIMS}\n`);
process.stderr.write('\nsession_id: fixture-session\n');
process.exit(0);
