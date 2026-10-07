#!/usr/bin/env node
// Real child process, fake protocol. Control data stays outside recorded argv.
import { readFileSync, writeFileSync } from 'node:fs';
import { claims, config, fixtureRevision, scenarios } from './ralph-worker-protocol.mjs';

const settings = config();
const scenario = settings.scenario ?? 'success';
if (!scenarios.includes(scenario)) throw new Error(`Unknown fixture scenario: ${scenario}`);
const argv = process.argv.slice(2);
const outputPaths = { ...settings.outputPaths };
for (const flag of settings.outputFlags ?? ['--final-output', '--output-last-message', '--output-file']) {
  const index = argv.indexOf(flag);
  if (index >= 0) {
    outputPaths[flag] = argv[index + 1];
    outputPaths.final ??= argv[index + 1];
  }
}
writeFileSync(settings.recordPath, JSON.stringify({
  fixtureRevision, scenarioId: settings.scenarioId ?? scenario, scenario,
  argv, cwd: process.cwd(), stdin: readFileSync(0, 'utf8'),
  envNames: Object.keys(process.env).sort(), outputPaths,
}));

const final = JSON.stringify({ type: 'result', result: claims(settings.worker) });
let output;
switch (scenario) {
  case 'success': output = `${final}\n`; break;
  case 'exit-zero-error': output = `${JSON.stringify({ type: 'error', error: 'Synthetic exit-zero failure' })}\n`; break;
  case 'missing-final': output = `${JSON.stringify({ type: 'message', text: 'Synthetic progress only' })}\n`; break;
  case 'double-final': output = `${final}\n${final}\n`; break;
  case 'truncated-final': output = final.slice(0, -8); break;
  case 'hang': setInterval(() => {}, 1000); break;
}
if (output !== undefined) {
  if (outputPaths.final) writeFileSync(outputPaths.final, output);
  process.stdout.write(output);
}
