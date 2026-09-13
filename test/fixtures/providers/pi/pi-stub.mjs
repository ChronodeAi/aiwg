#!/usr/bin/env node
// Offline Pi CLI stand-in. Default invocations mirror a healthy pinned Pi 0.85.0.
// AIWG_PI_STUB_SCENARIO selects a negative or long-running path for adapter
// contract tests; AIWG_PI_STUB_RECEIPT records what the stub observed.
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const scenario = process.env.AIWG_PI_STUB_SCENARIO || '';
const receipt = process.env.AIWG_PI_STUB_RECEIPT;
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const record = patch => {
  if (!receipt) return;
  let current = {};
  try { current = JSON.parse(readFileSync(receipt, 'utf8')); } catch { /* first write */ }
  writeFileSync(receipt, JSON.stringify({ ...current, ...patch }));
};

if (args.includes('--version')) {
  if (scenario === 'version-failure') {
    process.stderr.write('pi-stub: incompatible runtime\n');
    process.exitCode = 3;
  } else if (scenario === 'version-drift') {
    // A newer, unqualified Pi: exits 0, so only an explicit range check can reject it.
    process.stdout.write('0.86.0\n');
  } else {
    process.stdout.write('0.85.0\n');
  }
} else if (args.includes('--list-models')) {
  process.stdout.write('provider    model                 context  max-out\nopenrouter  fixture/model:free    32K      4K\n');
} else if (args.includes('--mode') && args[args.indexOf('--mode') + 1] === 'rpc') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    for (const line of input.split('\n').filter(Boolean)) {
      const command = JSON.parse(line);
      process.stdout.write(`${JSON.stringify({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        data: command.type === 'get_state' ? { isStreaming: false } : undefined,
      })}\n`);
    }
  });
} else if (args.includes('--mode') && args[args.indexOf('--mode') + 1] === 'json') {
  record({ argv: args, env: { CI: process.env.CI, NO_COLOR: process.env.NO_COLOR } });
  emit({ type: 'session', version: 3 });
  emit({ type: 'agent_start' });
  if (scenario) process.stderr.write('pi-stub diagnostic: stderr channel only\n');
  if (scenario === 'malformed') {
    process.stdout.write('not-json diagnostic leaked into stdout\n');
    emit({ type: 'agent_end', willRetry: false });
    emit({ type: 'agent_settled' });
  } else if (scenario === 'hang-until-abort') {
    let buffered = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      buffered += chunk;
      for (const line of buffered.split('\n').filter(Boolean)) {
        let command;
        try { command = JSON.parse(line); } catch { continue; }
        if (command.type !== 'abort') continue;
        record({ abort: command });
        emit({ type: 'agent_end', willRetry: false, stopReason: 'aborted' });
        emit({ type: 'agent_settled' });
        process.exit(0);
      }
    });
    setInterval(() => {}, 1000);
  } else if (scenario === 'ignore-stdin') {
    process.stdin.resume();
    setInterval(() => {}, 1000);
  } else if (scenario === 'block-until-stdin-eof') {
    // Mirrors Pi 0.85.0 `--mode json`: readPipedStdin() drains a non-TTY stdin
    // to EOF before the prompt runs. With stdin left open the session never
    // starts; with stdin closed ('ignore' -> /dev/null) it settles at once.
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      record({ stdinDrained: true, stdinBytes: input.length });
      emit({ type: 'agent_end', willRetry: false });
      emit({ type: 'agent_settled' });
      process.exit(0);
    });
    process.stdin.resume();
  } else {
    emit({ type: 'agent_end', willRetry: false });
    emit({ type: 'agent_settled' });
  }
} else {
  process.stderr.write('unsupported fixture invocation\n');
  process.exitCode = 2;
}
