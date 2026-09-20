#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const requestIndex = args.indexOf('--request');
if (requestIndex < 0 || !args[requestIndex + 1]) {
  console.error('Usage: decision-evaluate --request <dispatcher-request.json>');
  process.exit(2);
}
if (process.env.AIWG_DECISION_ENABLED !== '1') {
  console.error('Decision evaluation is disabled. Set AIWG_DECISION_ENABLED=1 to opt in.');
  process.exit(2);
}

const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../../../../');
const runtime = await import(pathToFileURL(path.join(packageRoot, 'dist/src/decision/index.js')).href);
const requestPath = path.resolve(args[requestIndex + 1]);
const config = JSON.parse(await readFile(requestPath, 'utf8'));
const base = path.dirname(requestPath);
const loadJson = async file => JSON.parse(await readFile(path.resolve(base, file), 'utf8'));

const ruleset = await loadJson(config.rulesetPath);
const binding = await loadJson(config.bindingPath);
const input = await loadJson(config.inputPath);
const definitions = {};
for (const file of config.definitionPaths ?? []) {
  const definition = await loadJson(file);
  definitions[definition.metadata.id] = definition;
}

const adapters = { jev: new runtime.JevDecisionAdapter() };
for (const [id, file] of Object.entries(config.adapterModules ?? {})) {
  const module = await import(pathToFileURL(path.resolve(base, file)).href);
  adapters[id] = module.default ?? (await module.createAdapter?.());
  if (!adapters[id]) throw new Error(`Adapter module '${file}' did not export an adapter`);
}

const credentials = config.credentials ?? {};
const resolveCredential = async logicalRef => {
  const envName = credentials[logicalRef];
  if (typeof envName !== 'string' || !envName) throw new Error(`No runtime credential mapping for '${logicalRef}'`);
  const value = process.env[envName];
  if (!value) throw new Error(`Credential environment variable '${envName}' is unavailable`);
  return new TextEncoder().encode(value);
};

const result = await runtime.evaluateDecisionRuleset({
  ruleset,
  binding,
  definitions,
  input,
  runId: config.runId,
  invocationId: config.invocationId,
  adapters,
  resolveCredential,
  ...(config.receiptDirectory
    ? { receiptStore: new runtime.FileDecisionReceiptStore(path.resolve(base, config.receiptDirectory)) }
    : {}),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.spec.status === 'error' || result.spec.status === 'cancelled' ? 1 : 0);
