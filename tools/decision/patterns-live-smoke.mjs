#!/usr/bin/env node
/** Explicitly opted-in, synthetic-only input/projection UAT, not quality qualification. */
import { getDecisionPatternPack, runLiveDecisionPattern } from '../../dist/src/decision/index.js';

if (process.env.AIWG_DECISION_JEV_LIVE_SMOKE !== '1'
    || !process.env.AIWG_DECISION_JEV_API_KEY || !process.env.AIWG_DECISION_JEV_REGION) {
  console.error('Requires AIWG_DECISION_JEV_LIVE_SMOKE=1, AIWG_DECISION_JEV_API_KEY and AIWG_DECISION_JEV_REGION. No calls made.');
  process.exit(2);
}
const region = process.env.AIWG_DECISION_JEV_REGION;
const model = 'jev-latest';
const semanticFields = {
  'intent-routing': ['request'], 'rag-screen': ['question', 'passage', 'comparisonSources'],
  'citation-support': ['claim', 'sourceText'], guardrails: ['content'],
  'tool-risk-preflight': ['proposedTool'], 'bounded-classification': ['text'],
  'ordinal-scoring': ['report'], 'function-selection': ['request', 'proposedArguments'],
  'same-subject-batch': ['summary'], 'durable-review': ['item'],
  'candidate-selection': ['task', 'criteria', 'evidence'],
};
let failed = false;
for (const [id, fields] of Object.entries(semanticFields)) {
  const pack = getDecisionPatternPack(id);
  const fixture = pack.fixtures.find(value => value.expected.route === 'accept') ?? pack.fixtures[0];
  const policy = {
    version: '1.0.0', provider: 'jev', model, origin: 'https://api.typesafe.ai', region,
    purpose: 'synthetic-decision', allowIncompleteContext: false,
    fields: fields.map(field => ({ pointer: `/${field}`, output: field, source: 'synthetic-fixture',
      subject: fixture.subjectId, trust: 'untrusted', sensitivity: 'public', purpose: 'synthetic-decision',
      retentionClass: 'ephemeral', accessScopes: ['decision-runtime'], exportPolicy: 'sanitized',
      deletionPolicy: 'erase', backupPolicy: 'not-persisted', allowedProviders: ['jev'], allowedModels: [model],
      allowedOrigins: ['https://api.typesafe.ai'], allowedRegions: [region] })),
  };
  let projectedCalls = 0;
  const receipt = await runLiveDecisionPattern(id, { synthetic: true, input: fixture.input },
    { explicitOptIn: true, credentialResolved: true, egressApproved: true }, {
      model, region, projection: { resolve: () => structuredClone(policy) },
      resolveCredential: async () => new TextEncoder().encode(process.env.AIWG_DECISION_JEV_API_KEY),
      estimate: () => ({ tokens: 1024, costUsd: 0.02 }),
      fetch: async (url, init) => {
        const state = JSON.parse(String(init?.body)).state;
        const subject = id === 'same-subject-batch' ? fixture.input.record : fixture.input;
        if (JSON.stringify(Object.keys(state.untrusted).sort()) !== JSON.stringify([...fields].sort())
            || Object.keys(state.verified).length
            || fields.some(field => JSON.stringify(state.untrusted[field]) !== JSON.stringify(subject[field]))) {
          throw new Error('Synthetic subject projection mismatch; egress denied');
        }
        projectedCalls += 1;
        return fetch(url, init);
      },
    });
  const evaluations = Object.values(receipt.result?.spec.evaluations ?? {});
  const valid = projectedCalls === pack.artifacts.definitions.length && receipt.limitBreaches.length === 0
    && evaluations.length === pack.artifacts.definitions.length
    && evaluations.every(value => ['success', 'abstained'].includes(value.spec.status));
  failed ||= !valid;
  console.log(JSON.stringify({ id, valid, projectedCalls, route: receipt.route, reason: receipt.reason,
    actualModel: receipt.actualModel, usage: receipt.usage, limitBreaches: receipt.limitBreaches,
    evaluations: evaluations.map(value => ({ status: value.spec.status, reason: value.spec.reason })),
    qualityQualified: false, action: receipt.action.status }));
}
process.exitCode = failed ? 1 : 0;
