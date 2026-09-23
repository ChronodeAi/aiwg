#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const frameworkRoot = process.env.AIWG_ROOT
  ? path.resolve(process.env.AIWG_ROOT)
  : path.resolve(import.meta.dirname, '../../..');
const tool = path.join(frameworkRoot, 'tools/quality/health.mjs');

const args = process.argv.slice(2);
let file = null;
let responsibility = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--responsibility') responsibility = args[++i] ?? '';
  else if (args[i] === '--dry-run' || args[i] === '--execute') continue;
  else if (!args[i].startsWith('-') && file === null) file = args[i];
}

function refuse(reason) {
  process.stderr.write(`decompose-file: ${reason}\n`);
  process.exit(2);
}

if (!file) refuse('usage: plan.mjs <file> --responsibility "<one sentence>" [--dry-run] [--execute]');
if (!responsibility || !responsibility.trim()) {
  refuse('responsibility required: pass --responsibility "<the reason to change the extracted module owns>"');
}
if (!fs.existsSync(path.resolve(file))) refuse(`file not found: ${file}`);

const result = spawnSync(process.execPath, [tool, '--functions', file, '--format', 'json'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
