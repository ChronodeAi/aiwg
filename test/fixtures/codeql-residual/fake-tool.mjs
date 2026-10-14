#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
const input = tool === 'curl' ? readFileSync(0, 'utf8') : '';
appendFileSync(process.env.AIWG_FAKE_TOOL_LOG, JSON.stringify({ tool, args, input }) + '\n');
if (process.env.AIWG_FAKE_TOOL_FAIL === tool) process.exit(7);
if (tool === 'git' && args[0] === 'diff') {
  process.stdout.write(args.includes('--name-status') ? `M\t${process.env.AIWG_FAKE_TOOL_FILE}\n` : 'literal diff\n');
} else if (tool === 'git' && args[0] === 'log') {
  process.stdout.write('abc123 ralph: fixture\n');
} else if (tool === 'tmux' && args[0] === 'list-panes') {
  process.stdout.write('4321\n');
} else if (tool === 'curl') {
  process.stdout.write('{"number":42}\n');
} else if (tool === 'instrument') {
  process.stdout.write('{"score":1,"pass_count":1,"total_count":1}\n');
} else if (tool === 'npm') {
  process.stdout.write('{"version":"1.2.3"}\n');
} else if (tool === 'clawhub' || tool === 'clawhub.mjs') {
  process.stdout.write('[]\n');
}
