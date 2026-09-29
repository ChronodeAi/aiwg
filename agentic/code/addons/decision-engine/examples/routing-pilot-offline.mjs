#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function findRoot(start) {
  let current = start;
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, 'package.json')) && existsSync(path.join(current, 'schemas/decision'))) return current;
    current = path.dirname(current);
  }
  throw new Error('AIWG source root not found');
}

const root = findRoot(import.meta.dirname);
const runtimePath = path.join(root, 'dist/src/decision/index.js');
if (!existsSync(runtimePath)) throw new Error('Build the CLI first: npm run build:cli');

const { runRoutingPilot } = await import(pathToFileURL(runtimePath).href);
const hash = char => `sha256:${char.repeat(64)}`;

function route(id, costMicros, taskFit) {
  return {
    id,
    taskFit,
    candidate: {
      id,
      binding: { id: `${id}-binding`, version: '1.0.0', digest: hash(id === 'economy' ? '1' : '2') },
      model: { provider: 'openai', backend: 'chat', requested: `${id}-alias`, pinnedVersion: `${id}-2026-09` },
      subagent: { id: `${id}-worker`, version: '1.0.0', digest: hash(id === 'economy' ? '3' : '4') },
      capabilities: ['docs', 'code'],
      permissions: { tools: ['read'], network: false, filesystem: 'read', secrets: [], actions: ['advise'] },
      policy: { privacy: ['internal'], authorizationScopes: ['example'], regions: ['us'], contextBytes: 12000, allowlisted: true, executable: true },
      operations: { health: 'healthy', latencyMsP95: id === 'economy' ? 100 : 250, priceCatalogVersion: 'synthetic-2026-09', costMicrosPerAttempt: costMicros, maxAttempts: 1, deadlineMs: 500 },
    },
  };
}

const routes = [route('economy', 100, 0.9), route('reasoning', 500, 0.86)];
const policy = {
  schemaVersion: 'decision-routing-policy/v1',
  id: 'routing-pilot-example',
  version: '1.0.0',
  mode: 'shadow',
  policyVersion: 'routing-shadow-example',
  candidates: routes.map(item => item.candidate),
  defaultRouteId: 'reasoning',
  deterministicFallbackRouteId: 'reasoning',
  utility: { taskFit: 100, complexityFit: 25, ambiguityPenalty: 10, latencyPenalty: 0.001, costPenalty: 0.001, healthPenalty: 50 },
  ceilings: { maxAttempts: 2, maxFallbacks: 1, maxCostMicros: 1000, deadlineMs: 2000, retryDelayMs: 1, unknownCost: 'reject' },
  jevEvidence: { enabled: true, calibrationRequired: true, compatibleProfiles: ['typesafe-route-fit-v1'], uncertaintyThresholdBps: 500 },
};

const task = {
  id: 'example-task',
  description: 'Synthetic docs and tests change',
  requirements: {
    capabilities: ['code'], privacy: 'internal', authorizationScopes: ['example'], region: 'us', tools: ['read'],
    contextBytes: 1024, allowlist: ['economy', 'reasoning'], maxCostMicros: 1000, deadlineMs: 2000,
  },
  state: { text: 'Synthetic routing example. No credentials, locators or private data.' },
  projection: {
    version: '1.0.0', provider: 'jev', model: 'router', origin: 'https://api.typesafe.ai', region: 'us',
    purpose: 'routing', allowIncompleteContext: false,
    fields: [{
      pointer: '/text', output: 'text', source: 'example', subject: 'example-task', trust: 'untrusted',
      sensitivity: 'internal', purpose: 'routing', retentionClass: 'ephemeral', accessScopes: ['decision-runtime'],
      exportPolicy: 'sanitized', deletionPolicy: 'erase', backupPolicy: 'not-persisted',
      allowedProviders: ['jev'], allowedModels: ['router'], allowedOrigins: ['https://api.typesafe.ai'], allowedRegions: ['us'],
    }],
  },
};

const receipt = await runRoutingPilot(policy, task, {
  enabled: true,
  now: () => 1_779_998_400_000,
  evidence: async request => ({
    schemaVersion: 'decision-routing-jev-evidence/v1',
    provider: 'jev',
    model: 'router',
    profile: 'typesafe-route-fit-v1',
    calibration: 'calibrated',
    provenance: { adapterVersion: 'fixture-1.0.0', requestDigest: hash('5'), responseDigest: hash('6') },
    taskComplexity: 0.35,
    ambiguity: 0.1,
    distributions: request.candidates.map(candidate => ({
      routeId: candidate.id,
      taskFit: routes.find(item => item.candidate.id === candidate.id).taskFit,
      reasoningNeed: candidate.id === 'reasoning' ? 0.9 : 0.3,
    })),
  }),
  dispatch: async ({ candidate }) => ({
    status: 'success',
    reason: 'none',
    actualProvider: candidate.model.provider,
    actualModel: candidate.model.pinnedVersion,
    workerId: candidate.subagent.id,
    inputTokens: 10,
    outputTokens: 4,
    costMicros: candidate.operations.costMicrosPerAttempt,
    latencyMs: candidate.operations.latencyMsP95,
    verified: true,
    outcomeLabel: 'synthetic-success',
  }),
});

console.log(JSON.stringify({
  status: receipt.status,
  selectedRouteId: receipt.selectedRouteId,
  eligibleRouteIds: receipt.eligibleRouteIds,
  attempts: receipt.attempts.map(attempt => ({ routeId: attempt.routeId, status: attempt.status, actualModel: attempt.actualModel })),
  costMicros: receipt.usage.costMicros,
}, null, 2));
