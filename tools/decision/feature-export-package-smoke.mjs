#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), 'aiwg-feature-export-package-'));
const packDir = join(tempRoot, 'pack');
const consumerDir = join(tempRoot, 'consumer');
mkdirSync(packDir);
mkdirSync(consumerDir);

const packOutput = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
const [packed] = JSON.parse(packOutput);
if (!packed?.filename) throw new Error('npm pack did not produce a tarball');
const tarball = join(packDir, packed.filename);
writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {} }, null, 2));
execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball], {
  cwd: consumerDir,
  stdio: 'inherit',
  env: { ...process.env, npm_config_prefer_offline: 'true' },
});
const probe = join(consumerDir, 'feature-export-consumer-probe.mjs');
writeFileSync(probe, `
import { createHash } from 'node:crypto';
import {
  DECISION_API_VERSION_STRUCTURED,
  artifactPin,
  buildDecisionFeatureEvalIntegrity,
  createDecisionFeatureObservation,
  generateDecisionFeatureSet,
  serializeDecisionFeatureJsonl,
} from 'aiwg/decision';

const definition = {
  apiVersion: DECISION_API_VERSION_STRUCTURED,
  kind: 'DecisionDefinition',
  metadata: { id: 'pkg-risk', version: '1.0.0', description: 'package smoke' },
  spec: { purpose: 'pkg', inputSchema: { type: 'object' }, question: 'risk?', answer: { kind: 'truth-probability', trueDescription: 'yes', falseDescription: 'no' }, requiredCapabilities: [] },
};
const ruleset = {
  apiVersion: DECISION_API_VERSION_STRUCTURED,
  kind: 'DecisionRuleset',
  metadata: { id: 'pkg-ruleset', version: '1.0.0', description: 'package smoke' },
  spec: { purpose: 'pkg', inputSchema: { type: 'object' }, evaluations: [{ alias: 'risk', decision: artifactPin(definition), inputPointer: '' }], rules: [{ id: 'manual-review', priority: 1, when: { op: 'eq', left: { source: 'input', pointer: '/never' }, right: true }, outcome: { route: 'review' } }], composition: 'collect', conflict: 'review', defaultOutcome: { route: 'review' }, failureOutcome: { route: 'review' }, outputSchema: { type: 'object' } },
};
const binding = {
  apiVersion: DECISION_API_VERSION_STRUCTURED,
  kind: 'DecisionBinding',
  metadata: { id: 'pkg-binding', version: '1.0.0', description: 'package smoke' },
  spec: { ruleset: artifactPin(ruleset), totalTimeoutMs: 1000, maxAttempts: 1, concurrency: 1, evaluations: { risk: { targets: [{ adapter: 'jev', adapterVersion: 'pkg', model: 'pkg-model', credentialRef: 'typesafe-api', requiredCapabilities: [], acceptance: { mode: 'typed-value' }, timeoutMs: 1000, retry: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1 } }], fallbackOn: [] } } },
};
const policy = { tenantId: 't', projectId: 'p', actorId: 'a', recipient: 'pkg', purpose: 'pkg', datasetPolicyId: 'dp', accessScope: 'feature-exporter', operations: ['create', 'list', 'read', 'export', 'delete', 'share'], allowExternalDelivery: true, allowRawState: false, allowOutcomeLabels: false };
const featureSet = generateDecisionFeatureSet({ id: 'pkg-features', version: '1.0.0', description: 'package smoke', ruleset, binding, definitions: { risk: definition }, compatibleServedModels: { risk: ['pkg-served'] }, privacy: { classification: 'restricted', retentionMs: 1000000, accessScope: 'feature-exporter', exportPolicyId: 'dp', deletion: 'tombstone', lifecycleSurface: 'export' } });
const result = { apiVersion: DECISION_API_VERSION_STRUCTURED, kind: 'DecisionResult', metadata: { id: 'pkg-result', version: '1.0.0', description: 'package smoke' }, spec: { decision: artifactPin(definition), ruleset: artifactPin(ruleset), binding: artifactPin(binding), alias: 'risk', runId: 'run', invocationId: 'inv', status: 'success', value: 0.7, reason: 'none', uncertainty: { source: 'provider', profile: 'pkg', calibration: 'measured', confidence: null, distribution: null, calibrationRef: null }, attempts: [{ ordinal: 1, adapter: 'jev', adapterVersion: 'pkg', requestedModel: 'pkg-model', actualModel: 'pkg-served', subagent: null, status: 'success', reason: 'none', durationMs: 1, usage: { inputTokens: null, outputTokens: null, costUsd: null }, requestId: null }] } };

function qualificationRelease(integrity) {
  const fields = { schemaVersion: 'decision-qualification-release/v1', runId: 'package-smoke', sourceCommit: '0000000000000000000000000000000000000000', dirty: false, environment: 'package-smoke', commands: ['feature-export-consumer-probe'], pins: { featureSet: featureSet.metadata.digest }, budgets: {}, actuals: {}, reviewer: null, suites: [], gates: [], integrity, benchmark: null, metrics: null, integritySnapshot: null, cacheLayers: null, decision: integrity.release_gate.decision };
  return { ...fields, digest: 'sha256:' + createHash('sha256').update(JSON.stringify(fields)).digest('hex') };
}

const row = createDecisionFeatureObservation({ featureSet, result, definitions: { risk: definition }, subjectId: 'subject', eventTime: '2026-09-24T00:00:00.000Z', exportTime: '2026-09-24T00:00:01.000Z', authorization: policy });
const evalIntegrity = buildDecisionFeatureEvalIntegrity({ qualificationRelease: qualificationRelease({ sample_n: 1, uncertainty: null, paired_baseline: null, integrity_mode: 'package-smoke', fresh_workspace_required: true, fresh_workspace_verified: true, integrity_state: 'hold', trusted_score_source: 'package-smoke', compromise_labels: [], weak_signal_reason: 'package smoke', release_gate: { decision: 'HOLD', reasons: ['package smoke'] } }), reportRef: 'package-smoke' });
const exported = serializeDecisionFeatureJsonl(featureSet, [row], policy, { generatedAt: '2026-09-24T00:00:02.000Z', evalIntegrity });
if (exported.manifest.rowCount !== 1 || exported.manifest.evalIntegrity?.qualificationRelease.integrity.release_gate.decision !== 'HOLD') throw new Error('package export failed');
console.log(JSON.stringify({ status: 'pass', digest: exported.manifest.semanticContentDigest }));
`);
const probeOutput = execFileSync(process.execPath, [probe], { cwd: consumerDir, encoding: 'utf8' });
const exampleOutput = execFileSync(process.execPath, ['node_modules/aiwg/tools/decision/feature-export-offline-smoke.mjs'], { cwd: consumerDir, encoding: 'utf8' });
const probeJson = JSON.parse(probeOutput);
const exampleJson = JSON.parse(exampleOutput);
if (probeJson.status !== 'pass' || exampleJson.status !== 'pass') throw new Error('installed package smoke failed');
const packageJson = JSON.parse(readFileSync(join(consumerDir, 'node_modules/aiwg/package.json'), 'utf8'));
console.log(JSON.stringify({ status: 'pass', package: `${packageJson.name}@${packageJson.version}`, tarball: packed.filename, probe: probeJson, exampleHeldout: exampleJson.heldout }, null, 2));
