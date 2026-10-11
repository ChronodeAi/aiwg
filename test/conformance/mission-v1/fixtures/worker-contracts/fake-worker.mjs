#!/usr/bin/env node
// Synthetic one-shot worker: no provider, network, account or credential access.
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(1);
const finalIndex = argv.indexOf('--final-output');
if (finalIndex < 0) throw new Error('Fixture requires --final-output');
const observation = {
  argv,
  cwd: process.cwd(),
  stdin: readFileSync(0, 'utf8'),
  envNames: Object.keys(process.env).sort(),
  finalPath: argv[finalIndex + 1],
};
writeFileSync(observation.finalPath, JSON.stringify({
  version: 1, status: 'completed', summary: 'Synthetic fixture only',
  claims: [], artifacts: [], checks: [], limitations: [],
}));
process.stdout.write(JSON.stringify(observation));
