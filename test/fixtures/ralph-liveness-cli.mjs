#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// IPC controls timing; stdout remains the worker protocol under observation.
const finalPath = process.argv[process.argv.indexOf('--final-output') + 1];
const emit = value => new Promise(resolve => process.stdout.write(`${JSON.stringify(value)}\n`, resolve));
const claims = { version: 1, status: 'completed', summary: 'synthetic', claims: [], artifacts: [], checks: [], limitations: [] };
const watchdog = setTimeout(() => process.exit(70), 10000);
let descendant;
process.on('exit', () => descendant?.kill('SIGKILL'));
process.on('message', async ({ step, id }) => {
  switch (step) {
    case 'accept': await emit({ type: 'turn.started' }); break;
    case 'edit':
      writeFileSync('partial.txt', 'synthetic partial work\n', { mode: 0o600 });
      await emit({ type: 'item.completed', item: { id: 'edit-1', type: 'command_execution' } });
      break;
    case 'churn':
      await emit({ type: 'item.completed', item: { id: 'edit-1', type: 'command_execution' } });
      await emit({ type: 'unrelated-log', text: 'synthetic keepalive' });
      break;
    case 'noise': await emit({ type: 'unrelated-log', text: 'synthetic keepalive' }); break;
    case 'rate-limit': process.stderr.write('429 rate_limit retry-after: 180\n'); break;
    case 'reset': process.stderr.write('ECONNRESET\n'); break;
    case 'ignore-term':
      process.on('SIGTERM', () => {});
      descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore', env: {},
      });
      await new Promise((resolve, reject) => { descendant.once('spawn', resolve); descendant.once('error', reject); });
      break;
    case 'final':
      writeFileSync(finalPath, JSON.stringify(claims));
      await emit({ type: 'turn.completed' });
      break;
    case 'crash': process.exit(17); break;
    case 'exit': clearTimeout(watchdog); process.exit(0); break;
    default: throw new Error('Unknown fixture step');
  }
  await emit({ fixtureStep: id, ...(descendant ? { descendant: descendant.pid } : {}) });
});
await emit({ fixtureStep: 'ready' });
