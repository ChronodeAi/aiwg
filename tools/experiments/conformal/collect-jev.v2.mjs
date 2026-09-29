import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DECISION_API_VERSION_STRUCTURED,
  evaluateDecisionRuleset,
  artifactPin,
  JevDecisionAdapter,
} from '../../../src/decision/index.ts';
import { digest, orderedRows, verifyFrozenOpenData } from './open-data.mjs';

const root = new URL('./', import.meta.url);

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function selectedRows(frozen, limit, split = 'finalTest') {
  const requested = split === 'all-scored' ? [...frozen.splits.finalTest, ...frozen.splits.shift] : frozen.splits[split];
  if (!requested) throw new Error(`unknown split '${split}'`);
  return orderedRows(requested).slice(0, limit);
}

export function estimateCollection(preregistration, itemCount) {
  const budget = preregistration.resourceBudget;
  if (!Number.isInteger(itemCount) || itemCount < 1) throw new Error('item count must be positive');
  if (itemCount > budget.liveMaxItems) throw new Error(`item count ${itemCount} exceeds manifest max ${budget.liveMaxItems}`);
  const estimatedUsd = Number((itemCount * budget.estimatedUsdPerItem).toFixed(2));
  if (estimatedUsd > budget.liveHardCeilingUsd || estimatedUsd > 8) {
    throw new Error(`estimated cost ${estimatedUsd} exceeds hard ceiling`);
  }
  return {
    providerCalls: itemCount,
    inputTokens: null,
    outputTokens: null,
    estimatedUsd,
    hardCeilingUsd: Math.min(8, budget.liveHardCeilingUsd),
    maxItems: budget.liveMaxItems,
  };
}

export function buildRuntimeArtifacts({ row, task, model }) {
  const definition = {
    apiVersion: DECISION_API_VERSION_STRUCTURED,
    kind: 'DecisionDefinition',
    metadata: {
      id: `${row.task}-jev-live`,
      version: '2.0.0',
      description: `Experimental #2613 live Choice scoring for ${row.task}`,
    },
    spec: {
      purpose: 'Experimental conformal open-data score collection; no action authorization.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1 } },
      },
      question: 'Classify the utterance into exactly one listed intent label. Return only the best matching option.',
      answer: {
        kind: 'choice',
        options: task.labels.map(id => ({ id, description: id })),
      },
      requiredCapabilities: ['choice'],
    },
  };
  const ruleset = {
    apiVersion: DECISION_API_VERSION_STRUCTURED,
    kind: 'DecisionRuleset',
    metadata: {
      id: `${row.task}-jev-live-ruleset`,
      version: '2.0.0',
      description: 'Experimental scorer wrapper; result data only.',
    },
    spec: {
      purpose: 'Collect a normalized DecisionResult for offline conformal analysis.',
      inputSchema: definition.spec.inputSchema,
      evaluations: [{ alias: 'label', decision: artifactPin(definition), inputPointer: '' }],
      rules: [{
        id: 'record-success',
        priority: 1,
        when: { op: 'exists', left: { source: 'decision', alias: 'label', pointer: '/value' } },
        outcome: 'scored',
      }],
      composition: 'first-match',
      conflict: 'error',
      defaultOutcome: 'review',
      failureOutcome: 'review',
      outputSchema: { type: 'string', enum: ['scored', 'review'] },
    },
  };
  const binding = {
    apiVersion: DECISION_API_VERSION_STRUCTURED,
    kind: 'DecisionBinding',
    metadata: {
      id: `${row.task}-jev-live-binding`,
      version: '2.0.0',
      description: 'Experimental default-off Jev collection binding.',
    },
    spec: {
      ruleset: artifactPin(ruleset),
      totalTimeoutMs: 30_000,
      maxAttempts: 1,
      concurrency: 1,
      evaluations: {
        label: {
          targets: [{
            adapter: 'jev',
            adapterVersion: '1.0.0',
            model,
            credentialRef: 'typesafe-api',
            requiredCapabilities: ['choice'],
            acceptance: { mode: 'typed-value' },
            timeoutMs: 30_000,
            retry: { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 },
          }],
          fallbackOn: [],
        },
      },
    },
  };
  return { definition, ruleset, binding };
}

function projectionPolicy({ row, model, region }) {
  return {
    version: 'conformal-2613-open-data-live/v1',
    provider: 'jev',
    model,
    origin: 'https://api.typesafe.ai',
    region,
    purpose: 'decision-conformal-2613-live-collection',
    allowIncompleteContext: false,
    maxSensitivity: 'public',
    fields: [{
      pointer: '/text',
      output: 'text',
      source: `${row.sourceDataset}:${row.canonicalSplit}:${row.sourceId}`,
      subject: row.id,
      trust: 'untrusted',
      sensitivity: 'public',
      purpose: 'decision-conformal-2613-live-collection',
      retentionClass: 'metadata-only-lineage-pending-d14',
      accessScopes: ['experimental-decision-evaluation'],
      exportPolicy: 'sanitized',
      deletionPolicy: 'tombstone',
      backupPolicy: 'not-persisted',
      allowedProviders: ['jev'],
      allowedModels: [model],
      allowedOrigins: ['https://api.typesafe.ai'],
      allowedRegions: [region],
    }],
  };
}

export async function scoreRowThroughRuntime({ row, task, model, region, adapter, credential }) {
  const { definition, ruleset, binding } = buildRuntimeArtifacts({ row, task, model });
  const result = await evaluateDecisionRuleset({
    ruleset,
    binding,
    definitions: { [definition.metadata.id]: definition },
    input: { text: row.text },
    runId: 'conformal-2613-live-collection',
    invocationId: `conformal-2613-${digest(row).slice(7, 23)}`,
    adapters: { jev: adapter },
    resolveCredential: async logical => {
      if (logical !== 'typesafe-api') throw new Error('unknown credential ref');
      return new TextEncoder().encode(credential);
    },
    projection: { resolve: () => projectionPolicy({ row, model, region }) },
  });
  const evaluation = result.spec.evaluations.label;
  return {
    id: row.id,
    task: row.task,
    split: row.split,
    label: row.label,
    status: evaluation?.spec.status ?? 'error',
    reason: evaluation?.spec.reason ?? result.spec.reason,
    value: evaluation?.spec.value ?? null,
    uncertainty: evaluation?.spec.uncertainty ? {
      source: evaluation.spec.uncertainty.source,
      profile: evaluation.spec.uncertainty.profile,
      calibration: evaluation.spec.uncertainty.calibration,
      confidence: evaluation.spec.uncertainty.confidence,
      distribution: evaluation.spec.uncertainty.distribution,
    } : null,
    usage: evaluation?.spec.attempts[0]?.usage ?? null,
    requestId: evaluation?.spec.attempts[0]?.requestId ?? null,
  };
}

export async function main(env = process.env) {
  const preregistration = JSON.parse(readFileSync(new URL('preregister.v2.json', root), 'utf8'));
  const frozen = JSON.parse(readFileSync(new URL('frozen.v2.json', root), 'utf8'));
  verifyFrozenOpenData(frozen, preregistration);
  const limit = Number(argValue('--limit', String(preregistration.resourceBudget.liveMaxItems)));
  const split = argValue('--split', 'finalTest');
  const model = argValue('--model', env.AIWG_DECISION_JEV_MODEL ?? 'jev-1.13.0');
  const rows = selectedRows(frozen, limit, split);
  const estimate = estimateCollection(preregistration, rows.length);
  const live = process.argv.includes('--live');
  const output = argValue('--output', new URL('./live-scores.v2.jsonl', root).pathname);
  const dryRun = {
    schemaVersion: 'conformal-jev-collection-plan/v2',
    issue: 2613,
    mode: live ? 'live-requested' : 'dry-run',
    envGateSet: env.AIWG_DECISION_JEV_LIVE_SMOKE === '1',
    credentialConfigured: Boolean(env.AIWG_DECISION_JEV_API_KEY),
    model,
    split,
    rows: rows.length,
    estimate,
    output,
    noCallsMade: !live,
  };
  if (!live) {
    console.log(JSON.stringify(dryRun, null, 2));
    return dryRun;
  }
  if (env.AIWG_DECISION_JEV_LIVE_SMOKE !== '1') throw new Error('AIWG_DECISION_JEV_LIVE_SMOKE=1 is required for live collection');
  if (!env.AIWG_DECISION_JEV_API_KEY) throw new Error('AIWG_DECISION_JEV_API_KEY is required for live collection');
  if (!env.AIWG_DECISION_JEV_REGION) throw new Error('AIWG_DECISION_JEV_REGION is required for D10 projection authorization');
  const adapter = new JevDecisionAdapter({ region: env.AIWG_DECISION_JEV_REGION });
  const records = [];
  for (const row of rows) {
    records.push(await scoreRowThroughRuntime({
      row,
      task: frozen.tasks[row.task],
      model,
      region: env.AIWG_DECISION_JEV_REGION,
      adapter,
      credential: env.AIWG_DECISION_JEV_API_KEY,
    }));
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  console.log(JSON.stringify({ ...dryRun, mode: 'live-complete', noCallsMade: false, output, records: records.length }, null, 2));
  return records;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
