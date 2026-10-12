#!/usr/bin/env node
// Synthetic 1.4.4-shaped direct fixture. No auth, inference or network.
import { readFileSync, writeFileSync } from 'node:fs';
import { claims, config } from '../../ralph-worker-protocol.mjs';

const settings = config();
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
let sequence = 0;
const emit = (type, payload) => process.stdout.write(JSON.stringify({ schema_version: 1, id: `record-${++sequence}`,
  stream: { kind: 'session', id: 'synthetic-session' }, sequence, record_type: 'event', payload_type: type,
  payload_schema_version: 1, payload: { kind: type === 'run.lifecycle.started' ? 'run_started'
    : type === 'run.output.delta' ? 'run_output_delta' : 'run_terminal', run_id: 'synthetic-run', ...payload } }) + '\n');
if (args.includes('--version')) {
  process.stdout.write('Muse Code 1.4.4 (1.4.4-R5419.1)\n');
} else {
  let stdinBytes = 0;
  for await (const chunk of process.stdin) stdinBytes += chunk.length;
  const brief = readFileSync(value('--prompt-file'), 'utf8');
  const schema = JSON.parse(readFileSync(value('--output-schema'), 'utf8'));
  writeFileSync(settings.recordPath, JSON.stringify({ argv: args, cwd: process.cwd(), stdinBytes, stdinEof: true,
    envNames: Object.keys(process.env).sort(), brief, schema }), { mode: 0o600 });
  const diagnosis = { trust: 'trust this workspace', auth: 'authentication expired HTTP 401', model: 'model_not_found',
    eperm: 'EPERM', erofs: 'EROFS', 'stdin-wait': 'Reading additional input from stdin' }[settings.scenario];
  if (diagnosis) { process.stderr.write(diagnosis + '\n'); process.exitCode = 1; }
  else if (settings.scenario === 'malformed') process.stdout.write('{malformed\n');
  else if (settings.scenario === 'no-handshake') setInterval(() => {}, 1000);
  else {
    if (settings.scenario !== 'final-only') emit('run.lifecycle.started', {});
    if (settings.scenario === 'hang') setInterval(() => {}, 1000);
    else {
      emit('run.output.delta', { text: 'synthetic partial evidence' });
      if (settings.scenario === 'quota' || settings.scenario === 'exit-zero-error') {
        emit('run.terminal.failed', { terminal: 'failed', text: '', reason: 'HTTP 429 Retry-After: 30',
          quota_scope: 'account:synthetic', reset_at: '2026-10-09T12:00:00Z' });
        process.exitCode = settings.scenario === 'exit-zero-error' ? 0 : 1;
      } else if (settings.scenario !== 'missing-final') {
        const text = JSON.stringify(claims({ provider: 'meta', model: value('--model'), effort: value('--reasoning-effort'), brief }));
        emit('run.terminal.completed', { terminal: 'completed', text });
        if (settings.scenario === 'double-final') emit('run.terminal.completed', { terminal: 'completed', text });
        if (settings.scenario === 'truncated-final') process.stdout.write('{"payload_type":');
      }
    }
  }
}
