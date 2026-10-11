#!/usr/bin/env node
// Synthetic 18.8.7-shaped direct-shell fixture. No auth, inference or network.
// OMP's own event names only: agent_start, tool_execution_end, agent_end
// (willContinue). Plain one-event-per-line JSON decodes through
// OmpFrameDecoder without any rpc_chunk reassembly.
import { writeFileSync } from 'node:fs';
import { claims, config } from '../../ralph-worker-protocol.mjs';

const settings = config();
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);

if (args.includes('--version')) {
  process.stdout.write('omp v18.8.7\n');
} else {
  // Unlike Pi's readPipedStdin, OMP's own readPipedInput (wUt) only trims
  // for the emptiness check; the returned/consumed text is untrimmed.
  let brief = '';
  for await (const chunk of process.stdin) brief += chunk;
  if (brief.trim().length === 0) brief = '';
  writeFileSync(settings.recordPath, JSON.stringify({ argv: args, cwd: process.cwd(), stdinEof: true,
    envNames: Object.keys(process.env).sort(), brief }), { mode: 0o600 });
  if (settings.scenario === 'no-handshake') { setInterval(() => {}, 1000); }
  else {
    emit({ type: 'agent_start' });
    if (settings.scenario === 'hang') { setInterval(() => {}, 1000); }
    else if (settings.scenario === 'malformed') {
      process.stdout.write('not-json diagnostic leaked into stdout\n');
    } else if (settings.scenario === 'error') {
      emit({ type: 'tool_execution_end', toolCallId: 'synthetic-tool-1', isError: true });
      emit({ type: 'agent_end', willContinue: false, messages: [{ role: 'assistant', stopReason: 'error' }] });
    } else if (settings.scenario === 'missing-final') {
      emit({ type: 'agent_end', willContinue: false });
    } else if (settings.scenario === 'plain-text-final') {
      // #2995: a settled, non-empty final answer that is plain text, not a
      // claims document — parseWorkerFinal must still reject it.
      emit({ type: 'tool_execution_end', toolCallId: 'synthetic-tool-1', isError: false });
      emit({ type: 'agent_end', willContinue: false, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'synthetic plain reply' }] }] });
    } else {
      emit({ type: 'tool_execution_end', toolCallId: 'synthetic-tool-1', isError: false });
      const text = JSON.stringify(claims({ provider: 'omp', model: value('--model'), effort: value('--thinking'), brief }));
      emit({ type: 'agent_end', willContinue: false, messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] });
      if (settings.scenario === 'exit-zero-error') emit({ type: 'error', message: 'synthetic standalone error' });
    }
  }
}
