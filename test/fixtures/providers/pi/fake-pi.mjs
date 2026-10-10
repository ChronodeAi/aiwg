#!/usr/bin/env node
// Synthetic 1.1.0-shaped direct-shell fixture. No auth, inference or network.
// Pi's own event names only: session, agent_start, agent_end, agent_settled.
import { writeFileSync } from 'node:fs';
import { claims, config } from '../../ralph-worker-protocol.mjs';

const settings = config();
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);

if (args.includes('--version')) {
  process.stdout.write('1.1.0\n');
} else {
  // Pi's own readPipedStdin() trims piped stdin and uses it as the sole
  // initial message; the fake mirrors that by draining stdin to EOF.
  let brief = '';
  for await (const chunk of process.stdin) brief += chunk;
  brief = brief.trim();
  writeFileSync(settings.recordPath, JSON.stringify({ argv: args, cwd: process.cwd(), stdinEof: true,
    envNames: Object.keys(process.env).sort(), brief }), { mode: 0o600 });
  if (settings.scenario === 'no-handshake') { setInterval(() => {}, 1000); }
  else {
    emit({ type: 'session', id: 'synthetic-session' });
    emit({ type: 'agent_start' });
    if (settings.scenario === 'hang') { setInterval(() => {}, 1000); }
    else if (settings.scenario === 'malformed') {
      process.stdout.write('not-json diagnostic leaked into stdout\n');
    } else if (settings.scenario === 'error') {
      emit({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', stopReason: 'error' }] });
      emit({ type: 'agent_settled' });
    } else if (settings.scenario === 'missing-final') {
      // agent_end with no assistant message, then settle: no final to parse.
      emit({ type: 'agent_end', willRetry: false });
      emit({ type: 'agent_settled' });
    } else {
      const text = JSON.stringify(claims({ provider: 'pi', model: value('--model'), effort: value('--thinking'), brief }));
      emit({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] });
      if (settings.scenario === 'exit-zero-error') emit({ type: 'error', message: 'synthetic standalone error' });
      emit({ type: 'agent_settled' });
    }
  }
}
