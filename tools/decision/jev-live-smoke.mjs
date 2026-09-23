#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.env.AIWG_DECISION_JEV_LIVE_SMOKE !== '1') {
  console.error('Live Jev smoke is opt-in. Set AIWG_DECISION_JEV_LIVE_SMOKE=1.');
  process.exit(2);
}
if (!process.env.AIWG_DECISION_JEV_API_KEY) {
  console.error('AIWG_DECISION_JEV_API_KEY is required and is never logged.');
  process.exit(2);
}

const root = process.cwd();
const runtime = await import(pathToFileURL(path.join(root, 'dist/src/decision/index.js')).href);
const definition = JSON.parse(await readFile(path.join(root, 'examples/decision/decision-category.json'), 'utf8'));
const binding = JSON.parse(await readFile(path.join(root, 'examples/decision/binding-jev.json'), 'utf8'));
const input = JSON.parse(await readFile(path.join(root, 'examples/decision/input.json'), 'utf8'));
const observation = await new runtime.JevDecisionAdapter().evaluate({
  alias: 'category', definition, input,
  target: binding.spec.evaluations.category.targets[0],
  invocationId: `live-${Date.now()}`,
  deadlineEpochMs: Date.now() + 15_000,
  signal: new AbortController().signal,
  resolveCredential: async () => new TextEncoder().encode(process.env.AIWG_DECISION_JEV_API_KEY),
});
process.stdout.write(`${JSON.stringify({ status: observation.status, reason: observation.reason, actualModel: observation.actualModel, usage: observation.usage }, null, 2)}\n`);
process.exit(observation.status === 'success' ? 0 : 1);
