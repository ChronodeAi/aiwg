import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DECISION_API_VERSION_STRUCTURED,
  evaluateDecisionRuleset,
  artifactPin,
  JevDecisionAdapter,
} from '../../../src/decision/index.ts';
import {
  compatibilityForTask,
  digest,
  experimentCodeVersion,
  orderedRows,
  rowHash,
  verifyFrozenOpenData,
} from './open-data.mjs';

const root = new URL('./', import.meta.url);

function parseArgs(argv = process.argv.slice(2)) {
  const args = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      args.set(value, argv[index + 1]);
      index += 1;
    } else flags.add(value);
  }
  return { args, flags };
}

function argValue(parsed, name, fallback = null) {
  return parsed.args.has(name) ? parsed.args.get(name) : fallback;
}

export function selectedRows(frozen, limit, split = 'finalTest') {
  const requested = split === 'all-scored'
    ? [...frozen.splits.calibration, ...frozen.splits.finalTest, ...frozen.splits.shift]
    : frozen.splits[split];
  if (!requested) throw new Error(`unknown split '${split}'`);
  return orderedRows(requested).slice(0, limit);
}

export function conservativeUsdPerCall(preregistration) {
  const budget = preregistration.resourceBudget;
  return Number((budget.conservativeMaxTokensPerCall * budget.conservativeUsdPerMillionTokens / 1_000_000).toFixed(6));
}

export function estimateCollection(preregistration, itemCount) {
  const budget = preregistration.resourceBudget;
  if (!Number.isInteger(itemCount) || itemCount < 1) throw new Error('item count must be positive');
  if (itemCount > budget.liveMaxItems) throw new Error(`item count ${itemCount} exceeds manifest max ${budget.liveMaxItems}`);
  const conservativeUsd = conservativeUsdPerCall(preregistration);
  const estimatedUsd = Number((itemCount * conservativeUsd).toFixed(2));
  if (estimatedUsd > budget.liveHardCeilingUsd || estimatedUsd > 8) {
    throw new Error(`estimated cost ${estimatedUsd} exceeds hard ceiling`);
  }
  return {
    providerCalls: itemCount,
    inputTokens: null,
    outputTokens: null,
    estimatedUsd,
    conservativeUsdPerCall: conservativeUsd,
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

function defaultOutputPath(env = process.env) {
  const stateRoot = env.XDG_STATE_HOME ?? (env.HOME ? join(env.HOME, '.local/state') : '/tmp');
  return join(stateRoot, 'aiwg/conformal-2613/live-scores.v2.jsonl');
}

function completedIds(output) {
  if (!existsSync(output)) return new Set();
  const ids = new Set();
  for (const line of readFileSync(output, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.schemaVersion === 'conformal-live-score/v2' && record.id && record.final === true) ids.add(record.id);
  }
  return ids;
}

function appendRecord(fd, record) {
  writeSync(fd, `${JSON.stringify(record)}\n`);
  fsyncSync(fd);
}

function usageCost(record, fallbackUsd) {
  const reported = record?.usage?.costUsd;
  return Number.isFinite(reported) && reported >= 0 ? reported : fallbackUsd;
}

function scoreCompatibility({ frozen, preregistration, taskId, model, codeVersion }) {
  const calibrationRows = orderedRows(frozen.splits.calibration.filter(row => row.task === taskId));
  return compatibilityForTask(frozen, taskId, 1 - preregistration.coverageTarget, codeVersion, {
    servedModel: model,
    adapter: 'jev-decision-runtime/v2',
    calibrationSplit: rowHash(calibrationRows),
  });
}

function scoreProbabilities(scored, task) {
  return Object.fromEntries(task.labels.map(label => [label, scored.uncertainty?.distribution?.[label] ?? (scored.value === label ? 1 : 0)]));
}

export async function collectLiveScores({ preregistration, frozen, rows, model, region, credential, output, adapter, codeVersion }) {
  const budget = preregistration.resourceBudget;
  const hardCeilingUsd = Math.min(8, budget.liveHardCeilingUsd);
  const reserveUsd = conservativeUsdPerCall(preregistration);
  const alreadyDone = completedIds(output);
  mkdirSync(dirname(output), { recursive: true });
  const fd = openSync(output, 'a');
  let chargedUsd = 0;
  let providerCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let consecutiveErrors = 0;
  let completed = 0;
  try {
    for (const row of rows) {
      if (alreadyDone.has(row.id)) continue;
      const task = frozen.tasks[row.task];
      const compatibility = scoreCompatibility({ frozen, preregistration, taskId: row.task, model, codeVersion });
      const attempts = [];
      let finalRecord = null;
      for (let attempt = 0; attempt <= budget.maxRetriesPerItem; attempt += 1) {
        if (chargedUsd + reserveUsd > hardCeilingUsd) {
          return { output, completed, skipped: alreadyDone.size, providerCalls, inputTokens, outputTokens, costUsd: chargedUsd, stoppedReason: 'budget-ceiling' };
        }
        providerCalls += 1;
        try {
          const scored = await scoreRowThroughRuntime({ row, task, model, region, adapter, credential });
          if (scored.status !== 'success') throw new Error(`live score failed: ${scored.reason ?? 'unknown'}`);
          const chargeUsd = usageCost(scored, reserveUsd);
          chargedUsd = Number((chargedUsd + chargeUsd).toFixed(6));
          inputTokens += scored.usage?.inputTokens ?? 0;
          outputTokens += scored.usage?.outputTokens ?? 0;
          attempts.push({ attempt: attempt + 1, status: scored.status, chargeUsd });
          finalRecord = {
            schemaVersion: 'conformal-live-score/v2',
            final: true,
            compatibility,
            probabilities: scoreProbabilities(scored, task),
            attempts,
            budgetChargeUsd: attempts.reduce((sum, entry) => sum + entry.chargeUsd, 0),
            ...scored,
          };
          consecutiveErrors = 0;
          break;
        } catch (error) {
          chargedUsd = Number((chargedUsd + reserveUsd).toFixed(6));
          attempts.push({
            attempt: attempt + 1,
            status: 'error',
            chargeUsd: reserveUsd,
            message: error instanceof Error ? error.message : String(error),
          });
          if (attempt === budget.maxRetriesPerItem) {
            consecutiveErrors += 1;
            finalRecord = {
              schemaVersion: 'conformal-live-score/v2',
              final: true,
              id: row.id,
              task: row.task,
              split: row.split,
              label: row.label,
              status: 'error',
              value: null,
              uncertainty: null,
              usage: null,
              requestId: null,
              compatibility,
              attempts,
              budgetChargeUsd: attempts.reduce((sum, entry) => sum + entry.chargeUsd, 0),
            };
          }
        }
      }
      appendRecord(fd, finalRecord);
      completed += 1;
      if (consecutiveErrors >= budget.maxConsecutiveErrors) {
        return { output, completed, skipped: alreadyDone.size, providerCalls, inputTokens, outputTokens, costUsd: chargedUsd, stoppedReason: 'consecutive-errors' };
      }
    }
  } finally {
    closeSync(fd);
  }
  return { output, completed, skipped: alreadyDone.size, providerCalls, inputTokens, outputTokens, costUsd: chargedUsd, stoppedReason: null };
}

export async function main(env = process.env, argv = process.argv.slice(2), hooks = {}) {
  const parsed = parseArgs(argv);
  const preregistration = JSON.parse(readFileSync(new URL('preregister.v2.json', root), 'utf8'));
  const frozen = JSON.parse(readFileSync(new URL('frozen.v2.json', root), 'utf8'));
  verifyFrozenOpenData(frozen, preregistration);
  const limit = Number(argValue(parsed, '--limit', String(preregistration.resourceBudget.liveMaxItems)));
  const split = argValue(parsed, '--split', 'finalTest');
  const model = argValue(parsed, '--model', env.AIWG_DECISION_JEV_MODEL ?? 'jev-1.13.0');
  const rows = selectedRows(frozen, limit, split);
  const estimate = estimateCollection(preregistration, rows.length);
  const live = parsed.flags.has('--live');
  const output = argValue(parsed, '--output', defaultOutputPath(env));
  const dryRun = {
    schemaVersion: 'conformal-jev-collection-plan/v2',
    issue: 2613,
    mode: live ? 'live-requested' : 'dry-run',
    envGateSet: env.AIWG_DECISION_JEV_LIVE_SMOKE === '1',
    credentialConfigured: Boolean(env.AIWG_DECISION_JEV_API_KEY),
    regionConfigured: Boolean(env.AIWG_DECISION_JEV_REGION),
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
  const adapter = hooks.adapter ?? new JevDecisionAdapter({ region: env.AIWG_DECISION_JEV_REGION });
  const summary = await collectLiveScores({
    preregistration,
    frozen,
    rows,
    model,
    region: env.AIWG_DECISION_JEV_REGION,
    credential: env.AIWG_DECISION_JEV_API_KEY,
    output,
    adapter,
    codeVersion: experimentCodeVersion(root),
  });
  console.log(JSON.stringify({ ...dryRun, mode: 'live-complete', noCallsMade: false, ...summary }, null, 2));
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
