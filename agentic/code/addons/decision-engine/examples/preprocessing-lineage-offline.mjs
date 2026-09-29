import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDecisionRuntime } from '../skills/decision-evaluate/scripts/runtime-root.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../../..');
const usage = { inputTokens: 4, outputTokens: 1, costUsd: null };

async function json(relativePath) {
  return JSON.parse(await readFile(path.resolve(root, relativePath), 'utf8'));
}

function adapter(seen) {
  return {
    id: 'jev',
    version: '1.0.0',
    async capabilities() {
      return {
        answerKinds: ['choice', 'ordinal-score', 'truth-probability'],
        features: ['choice', 'ordinal-score', 'truth-probability'],
        maxOptions: 255,
        maxLevels: 10,
        confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'],
        executable: true,
        egress: { mode: 'none' },
      };
    },
    async evaluate(request) {
      seen.push(request.input);
      const kind = request.definition.spec.answer.kind;
      if (kind === 'choice') {
        const value = request.definition.spec.answer.options[0].id;
        return {
          status: 'success',
          reason: 'none',
          value,
          uncertainty: { source: 'provider', profile: 'typesafe-distribution-v1', calibration: 'vendor-claimed',
            confidence: 0.9, distribution: null, calibrationRef: null },
          actualModel: 'offline:preprocessing-lineage',
          usage,
          requestId: null,
        };
      }
      return {
        status: 'success',
        reason: 'none',
        value: kind === 'ordinal-score' ? 0 : 0.01,
        uncertainty: { source: 'provider', profile: kind === 'ordinal-score' ? 'typesafe-distribution-v1' : 'typesafe-truth-v1',
          calibration: 'vendor-claimed', confidence: 0.9, distribution: null, calibrationRef: null },
        actualModel: 'offline:preprocessing-lineage',
        usage,
        requestId: null,
      };
    },
  };
}

export async function runPreprocessingLineageExample(runtime, { invocationId = 'preprocessing-lineage-offline' } = {}) {
  const fixture = await json('test/fixtures/decision/preprocessing/multimodal-lineage-v1.json');
  const manifest = fixture.fixtures.find(item => item.id === 'scanned-document-ocr').manifest;
  // A no-egress local adapter with no projection policy is the local destination for this adapter.
  const destination = { provider: 'jev', origin: runtime.PREPROCESSING_LOCAL_ORIGIN };
  manifest.spec.policy.derivedEgress.destinations = [destination];
  const resolved = runtime.resolvePreprocessedEvidence([manifest], { destination, minQualityScore: 0.8 });
  const seen = [];
  const result = await runtime.evaluateDecisionRuleset({
    ruleset: await json('agentic/code/addons/decision-engine/examples/ruleset.json'),
    binding: await json('agentic/code/addons/decision-engine/examples/binding-jev.json'),
    definitions: {
      category: await json('agentic/code/addons/decision-engine/examples/decision-category.json'),
      severity: await json('agentic/code/addons/decision-engine/examples/decision-severity.json'),
      core: await json('agentic/code/addons/decision-engine/examples/decision-core_unavailable.json'),
    },
    input: { message: resolved.state.text },
    runId: 'preprocessing-lineage-offline',
    invocationId,
    adapters: { jev: adapter(seen) },
    preprocessingLineage: resolved.receiptEvidence,
    // The host's current manifest record: stored lineage references are re-checked against it.
    preprocessingVerification: { manifests: [manifest] },
  });
  return {
    status: result.spec.status,
    reason: result.spec.reason,
    lineageReferences: result.spec.preprocessingLineage?.references.length ?? 0,
    dispatchedTextOnly: seen.every(input => typeof input === 'object' && input !== null && !JSON.stringify(input).includes('asset-invoice-scan-314')),
    receiptBodyFree: !JSON.stringify(result).includes(manifest.spec.output.value),
    result,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await import(pathToFileURL(resolveDecisionRuntime(import.meta.url)).href);
  const summary = await runPreprocessingLineageExample(runtime);
  process.stdout.write(`${JSON.stringify({
    status: summary.status,
    reason: summary.reason,
    lineageReferences: summary.lineageReferences,
    dispatchedTextOnly: summary.dispatchedTextOnly,
    receiptBodyFree: summary.receiptBodyFree,
  })}\n`);
}
