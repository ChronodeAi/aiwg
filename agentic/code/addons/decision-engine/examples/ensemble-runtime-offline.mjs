#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
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
if (!existsSync(runtimePath)) {
  throw new Error('Build the CLI first: npm run build:cli');
}

const {
  executeDecisionEnsemble,
} = await import(pathToFileURL(runtimePath).href);

const fixture = JSON.parse(readFileSync(path.join(root, 'test/fixtures/decision/ensemble/ensemble-policy.v1.valid.json'), 'utf8'));
const policy = fixture.records.find(record => record.id === 'triage-choice-ensemble');

function memberResult(member, sampleIndex) {
  return {
    apiVersion: 'decision.aiwg.io/v1alpha1',
    kind: 'DecisionResult',
    metadata: { id: `${member.id}-${sampleIndex}`, version: '1.0.0', description: 'offline ensemble fixture' },
    spec: {
      decision: member.definition,
      ruleset: member.definition,
      binding: member.binding,
      alias: member.id,
      runId: 'offline-ensemble',
      invocationId: `offline:${member.id}:${sampleIndex}`,
      status: 'success',
      value: member.id === 'jev-c' ? 'deny' : 'approve',
      reason: 'none',
      uncertainty: {
        source: 'provider',
        profile: member.uncertaintyProfile,
        calibration: 'vendor-claimed',
        confidence: 0.9,
        distribution: { approve: 0.7, deny: 0.2, escalate: 0.1 },
        calibrationRef: null,
      },
      attempts: [{
        ordinal: 1,
        adapter: member.adapter.id,
        adapterVersion: member.adapter.version,
        requestedModel: member.model.requested,
        actualModel: member.model.pinnedVersion,
        subagent: null,
        status: 'success',
        reason: 'none',
        durationMs: 5,
        usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.001 },
        requestId: `offline-${member.id}-${sampleIndex}`,
      }],
    },
  };
}

const result = await executeDecisionEnsemble(policy, {
  enabled: true,
  invocationId: 'offline-example',
  authorizeMember: () => true,
  dispatch: async request => memberResult(request.member, request.sampleIndex),
});

console.log(JSON.stringify({
  status: result.status,
  outcome: result.aggregate?.outcome,
  disagreement: result.aggregate?.disagreement,
  warnings: result.aggregate?.warnings,
  retainedResults: Object.keys(result.retainedResults).length,
}, null, 2));
