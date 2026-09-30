import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  DECISION_API_VERSION_STRUCTURED,
  evaluateDecisionRuleset,
  artifactPin,
  JevDecisionAdapter,
} from '../../../src/decision/index.ts';
import {
  assertCompatibleProfile,
  digest,
  expectedLiveCompatibility,
  liveSubsetRows,
  verifyFrozenOpenData,
} from './open-data.mjs';

export { liveSubsetRows };

const root = new URL('./', import.meta.url);

export const SCORES_FILE = 'live-scores.v2.jsonl';
export const LEDGER_FILE = 'spend-ledger.v2.jsonl';
const LOCK_FILE = 'collector.lock';
const RECORD_SCHEMA = 'conformal-live-score/v2';
const LEDGER_SCHEMA = 'conformal-spend-ledger/v2';
// Terminal results are never re-requested on resume; `error` records are retried within the attempt cap.
const TERMINAL_STATUSES = new Set(['success', 'missing-distribution']);
const LIVE_QUESTION = 'Classify the utterance into exactly one listed intent label. Return only the best matching option.';

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

/** USD per million tokens times tokens is micro-USD, so every budget quantity is an integer. */
export function reservationMicros(preregistration) {
  const budget = preregistration.resourceBudget;
  return Math.ceil(budget.maxInputTokensPerCall * budget.inputUsdPerMillionTokensCeiling
    + budget.maxOutputTokensPerCall * budget.outputUsdPerMillionTokensCeiling);
}

export function hardCeilingMicros(preregistration) {
  return Math.round(Math.min(8, preregistration.resourceBudget.liveHardCeilingUsd) * 1_000_000);
}

/**
 * Charge for one dispatched call. Reported tokens are priced at the pinned ceiling; a reported
 * provider cost is honored when higher. Unknown usage is charged the full worst-case reservation.
 */
export function chargeForUsage(preregistration, usage) {
  const budget = preregistration.resourceBudget;
  const reservation = reservationMicros(preregistration);
  const known = value => Number.isSafeInteger(value) && value >= 0;
  const tokensKnown = known(usage?.inputTokens) && known(usage?.outputTokens);
  const reportedMicros = Number.isFinite(usage?.costUsd) && usage.costUsd >= 0 ? Math.ceil(Number((usage.costUsd * 1_000_000).toFixed(3))) : null;
  if (!tokensKnown) {
    return { chargedMicros: Math.max(reservation, reportedMicros ?? 0), basis: 'unknown-tokens-reservation' };
  }
  const tokenMicros = Math.ceil(usage.inputTokens * budget.inputUsdPerMillionTokensCeiling
    + usage.outputTokens * budget.outputUsdPerMillionTokensCeiling);
  return reportedMicros !== null && reportedMicros > tokenMicros
    ? { chargedMicros: reportedMicros, basis: 'reported-provider-cost' }
    : { chargedMicros: tokenMicros, basis: 'reported-tokens-at-price-ceiling' };
}

export function estimateCollection(preregistration, itemCount, spentMicros = 0) {
  const budget = preregistration.resourceBudget;
  if (!Number.isInteger(itemCount) || itemCount < 1) throw new Error('item count must be positive');
  if (itemCount > budget.liveMaxItems) throw new Error(`item count ${itemCount} exceeds manifest max ${budget.liveMaxItems}`);
  const reservation = reservationMicros(preregistration);
  const ceiling = hardCeilingMicros(preregistration);
  const worstCase = itemCount * reservation;
  if (worstCase > ceiling - spentMicros) {
    throw new Error(`worst-case cost ${worstCase / 1e6} USD exceeds remaining ceiling ${(ceiling - spentMicros) / 1e6} USD`);
  }
  return {
    providerCalls: itemCount,
    reservationUsdPerCall: reservation / 1e6,
    worstCaseUsd: itemCount * reservation / 1e6,
    spentUsd: spentMicros / 1e6,
    remainingUsd: (ceiling - spentMicros) / 1e6,
    hardCeilingUsd: ceiling / 1e6,
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
      question: LIVE_QUESTION,
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

/** Digest of the exact live prompt, runtime artifacts and projection template for every live task. */
export function livePromptDigest(frozen, model) {
  const placeholder = { sourceDataset: '{sourceDataset}', canonicalSplit: '{canonicalSplit}', sourceId: '{sourceId}', id: '{id}' };
  const tasks = Object.keys(frozen.tasks).sort();
  return digest(Object.fromEntries(tasks.map(taskId => [taskId, {
    artifacts: buildRuntimeArtifacts({ row: { task: taskId }, task: frozen.tasks[taskId], model }),
    projection: projectionPolicy({ row: placeholder, model, region: '{region}' }),
  }])));
}

export function collectorSourceDigest() {
  return digest(readFileSync(new URL('collect-jev.v2.mjs', root), 'utf8'));
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
  const attempt = evaluation?.spec.attempts[0] ?? null;
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
    usage: attempt?.usage ?? null,
    requestId: attempt?.requestId ?? null,
    actualModel: attempt?.actualModel ?? null,
    latencyMs: attempt?.durationMs ?? null,
    dispatched: Boolean(attempt),
  };
}

const measuredBytes = new Map();

/**
 * Exact byte length of the Jev request body for one row, captured from the real Jev adapter with a
 * local transport that never touches the network. Byte-level tokenizers emit at most one token per
 * byte, so this bounds the prompt tokens the collector controls.
 */
export function measureRequestBytes({ row, task, model, region }) {
  const key = `${model}\0${region}\0${row.id}\0${digest(row)}`;
  if (measuredBytes.has(key)) return measuredBytes.get(key);
  let body = null;
  const adapter = new JevDecisionAdapter({
    region,
    fetch: async (_url, init) => {
      body = String(init.body);
      return new Response('{}', { status: 599, headers: { 'content-type': 'application/json' } });
    },
  });
  return scoreRowThroughRuntime({ row, task, model, region, adapter, credential: 'request-size-probe' }).then(() => {
    if (body === null) throw new Error(`request size probe did not capture a body for ${row.id}`);
    const bytes = Buffer.byteLength(body, 'utf8');
    measuredBytes.set(key, bytes);
    return bytes;
  });
}

/**
 * Reads JSONL. One trailing partial line (a crash mid-append) is tolerated: with `repair` it is moved
 * to `<path>.quarantine` and truncated away; otherwise it is ignored and reported. Any other corrupt
 * line fails closed.
 */
export function readJsonl(path, { repair = false } = {}) {
  if (!existsSync(path)) return { entries: [], trailingPartial: null };
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const trailing = lines.pop();
  const entries = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`corrupt JSONL line ${index + 1} in ${path}`);
    }
  });
  if (!trailing) return { entries, trailingPartial: null };
  if (repair) {
    const quarantine = openSync(`${path}.quarantine`, 'a');
    try {
      writeSync(quarantine, `${trailing}\n`);
      fsyncSync(quarantine);
    } finally {
      closeSync(quarantine);
    }
    const fd = openSync(path, 'r+');
    try {
      ftruncateSync(fd, Buffer.byteLength(text, 'utf8') - Buffer.byteLength(trailing, 'utf8'));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  return { entries, trailingPartial: trailing };
}

function appendLine(fd, value) {
  writeSync(fd, `${JSON.stringify(value)}\n`);
  fsyncSync(fd);
}

export function ledgerPathFor(stateDir) {
  return join(stateDir, LEDGER_FILE);
}

function withoutField(value, field) {
  const { [field]: _omitted, ...rest } = value;
  return rest;
}

export function recordDigest(record) {
  return digest(withoutField(record, 'recordDigest'));
}

/**
 * Hash-chained, append-only spend ledger shared by every run in one experiment state directory.
 * A reservation is written (and fsynced) before dispatch; until it is settled it counts as spent.
 */
export function readSpendLedger(path, { repair = false } = {}) {
  const { entries, trailingPartial } = readJsonl(path, { repair });
  let previous = null;
  const reservations = new Map();
  const reservationsByItem = new Map();
  const recordDigests = new Set();
  let halted = null;
  entries.forEach((entry, index) => {
    if (entry.schemaVersion !== LEDGER_SCHEMA || entry.seq !== index || entry.prev !== previous || entry.digest !== digest(withoutField(entry, 'digest'))) {
      throw new Error(`spend ledger chain is broken at entry ${index} in ${path}`);
    }
    previous = entry.digest;
    if (entry.type === 'reserve') {
      if (reservations.has(entry.reservationId)) throw new Error(`spend ledger repeats reservation ${entry.reservationId} at entry ${index}`);
      reservations.set(entry.reservationId, { reserved: entry.reservedMicros, charged: null });
      reservationsByItem.set(entry.itemId, (reservationsByItem.get(entry.itemId) ?? 0) + 1);
    }
    else if (entry.type === 'settle') {
      const reservation = reservations.get(entry.reservationId);
      if (!reservation || reservation.charged !== null) throw new Error(`spend ledger settles an unknown reservation at entry ${index}`);
      reservation.charged = entry.chargedMicros;
    } else if (entry.type === 'record') recordDigests.add(`${entry.itemId}\0${entry.recordDigest}`);
    else if (entry.type === 'halt') halted = entry.reason;
    else throw new Error(`unknown spend ledger entry type at ${index}`);
  });
  const spentMicros = [...reservations.values()].reduce((sum, item) => sum + (item.charged ?? item.reserved), 0);
  return { entries, head: previous, spentMicros, halted, recordDigests, reservationsByItem, trailingPartial };
}

class LedgerWriter {
  constructor(path, ledger, preregistrationHash) {
    this.fd = openSync(path, 'a');
    this.seq = ledger.entries.length;
    this.prev = ledger.head;
    this.preregistrationHash = preregistrationHash;
  }

  append(fields) {
    const entry = { schemaVersion: LEDGER_SCHEMA, seq: this.seq, prev: this.prev, preregistrationHash: this.preregistrationHash, ...fields };
    entry.digest = digest(entry);
    appendLine(this.fd, entry);
    this.seq += 1;
    this.prev = entry.digest;
    return entry;
  }

  close() {
    closeSync(this.fd);
  }
}

function recordChargeMicros(record) {
  if (Number.isSafeInteger(record.budgetChargeMicros) && record.budgetChargeMicros >= 0) return record.budgetChargeMicros;
  if (Number.isFinite(record.budgetChargeUsd) && record.budgetChargeUsd >= 0) return Math.ceil(Number((record.budgetChargeUsd * 1e6).toFixed(3)));
  return 0;
}

/** Sum of charges recorded by every score file in the experiment state directory. */
export function recordedSpendMicros(stateDir) {
  if (!existsSync(stateDir)) return 0;
  let total = 0;
  for (const name of readdirSync(stateDir).sort()) {
    if (!name.endsWith('.jsonl') || name === LEDGER_FILE) continue;
    for (const record of readJsonl(join(stateDir, name)).entries) {
      if (record?.schemaVersion === RECORD_SCHEMA) total += recordChargeMicros(record);
    }
  }
  return total;
}

/** Global spend for the experiment: the larger of the durable ledger and all recorded charges. */
export function experimentSpendMicros(stateDir) {
  const ledger = readSpendLedger(ledgerPathFor(stateDir));
  return { spentMicros: Math.max(ledger.spentMicros, recordedSpendMicros(stateDir)), halted: ledger.halted };
}

function acquireLock(stateDir) {
  const path = join(stateDir, LOCK_FILE);
  let fd;
  try {
    fd = openSync(path, 'wx');
  } catch {
    throw new Error(`another collector holds ${path}; remove it only after confirming no collector is running`);
  }
  writeSync(fd, `${process.pid}\n`);
  closeSync(fd);
  return () => unlinkSync(path);
}

function classify(scored, thrown, model) {
  if (thrown || !scored) return { status: 'error', reason: 'collector-exception' };
  if (scored.status !== 'success') return { status: 'error', reason: scored.reason ?? 'unknown' };
  if (scored.actualModel !== model) return { status: 'error', reason: 'served-model-mismatch' };
  const distribution = scored.uncertainty?.distribution;
  if (!distribution || typeof distribution !== 'object') return { status: 'missing-distribution', reason: 'no-native-distribution' };
  return { status: 'success', reason: 'none' };
}

function buildRecord({ row, task, scored, outcome, attempts, priorAttempts, compatibility, collectorInfo }) {
  const chargeMicros = attempts.reduce((sum, entry) => sum + entry.chargedMicros, 0);
  const success = outcome.status === 'success';
  const record = {
    schemaVersion: RECORD_SCHEMA,
    final: true,
    id: row.id,
    task: row.task,
    split: row.split,
    label: row.label,
    status: outcome.status,
    reason: outcome.reason,
    value: success || outcome.status === 'missing-distribution' ? scored.value : null,
    uncertainty: success ? scored.uncertainty : null,
    ...(success ? { probabilities: Object.fromEntries(task.labels.map(label => [label, scored.uncertainty.distribution[label]])) } : {}),
    actualModel: scored?.actualModel ?? null,
    usage: scored?.usage ?? null,
    requestId: scored?.requestId ?? null,
    latencyMs: scored?.latencyMs ?? null,
    compatibility,
    collector: collectorInfo,
    attempts,
    totalAttempts: priorAttempts + attempts.length,
    budgetChargeMicros: chargeMicros,
    budgetChargeUsd: chargeMicros / 1e6,
  };
  return { ...record, recordDigest: digest(record) };
}

export async function collectLiveScores({ preregistration, frozen, rows, model, region, credential, stateDir, output, adapter }) {
  const budget = preregistration.resourceBudget;
  const pins = preregistration.pins;
  if (model !== pins.liveServedModel) throw new Error(`model '${model}' is not the pinned live served model '${pins.liveServedModel}'`);
  if (collectorSourceDigest() !== pins.collectorCodeDigest) throw new Error('collector code differs from the preregistered collectorCodeDigest pin');
  if (livePromptDigest(frozen, model) !== pins.livePromptDigest) throw new Error('live prompt digest differs from the preregistered livePromptDigest pin');
  const allowed = new Map(liveSubsetRows(frozen).map(row => [row.id, row]));
  for (const row of rows) {
    if (!allowed.has(row.id) || digest(allowed.get(row.id)) !== digest(row)) throw new Error(`row ${row.id} is not in the preregistered live subset`);
  }
  const directory = resolve(stateDir ?? dirname(output));
  const scoresPath = resolve(output ?? join(directory, SCORES_FILE));
  if (dirname(scoresPath) !== directory) throw new Error('score output must live in the experiment state directory next to its spend ledger');
  mkdirSync(directory, { recursive: true });
  const release = acquireLock(directory);
  const reservation = reservationMicros(preregistration);
  const ceiling = hardCeilingMicros(preregistration);
  const preregistrationHash = digest(preregistration);
  const collectorInfo = { version: pins.collectorCodeDigest, preregistrationHash, frozenSampleDigest: frozen.sampleDigest };
  let writer = null;
  let fd = null;
  try {
    const ledgerPath = ledgerPathFor(directory);
    const ledger = readSpendLedger(ledgerPath, { repair: true });
    const existing = readJsonl(scoresPath, { repair: true }).entries.filter(record => record?.schemaVersion === RECORD_SCHEMA);
    for (const record of existing) {
      try {
        assertCompatibleProfile(record.compatibility, expectedLiveCompatibility(frozen, preregistration, record.task));
      } catch (error) {
        throw new Error(`refusing to resume into incompatible score file ${scoresPath}: ${error.message}`);
      }
    }
    const latest = new Map();
    const priorAttempts = new Map();
    for (const record of existing) {
      latest.set(record.id, record);
      priorAttempts.set(record.id, (priorAttempts.get(record.id) ?? 0) + (Array.isArray(record.attempts) ? record.attempts.length : 1));
    }
    // Reservations orphaned by a crash before settlement still count as attempts.
    for (const [itemId, count] of ledger.reservationsByItem) priorAttempts.set(itemId, Math.max(priorAttempts.get(itemId) ?? 0, count));
    let spent = Math.max(ledger.spentMicros, recordedSpendMicros(directory));
    const startingSpentMicros = spent;
    let completed = 0;
    let providerCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let consecutiveErrors = 0;
    const pending = rows.filter(row => !TERMINAL_STATUSES.has(latest.get(row.id)?.status)
      && (priorAttempts.get(row.id) ?? 0) < budget.maxAttemptsPerItemTotal);
    const summary = stoppedReason => ({
      output: scoresPath,
      ledger: ledgerPath,
      completed,
      skipped: rows.length - pending.length,
      providerCalls,
      inputTokens,
      outputTokens,
      startingSpentMicros,
      endingSpentMicros: spent,
      costUsd: (spent - startingSpentMicros) / 1e6,
      spentUsd: spent / 1e6,
      stoppedReason,
    });
    if (ledger.halted) return summary('ledger-halted');
    for (const row of pending) {
      const bytes = await measureRequestBytes({ row, task: frozen.tasks[row.task], model, region });
      if (bytes + budget.serverOverheadTokensAllowance > budget.maxInputTokensPerCall) {
        throw new Error(`request for ${row.id} is ${bytes} bytes; with the server allowance it exceeds maxInputTokensPerCall`);
      }
    }
    writer = new LedgerWriter(ledgerPath, ledger, preregistrationHash);
    fd = openSync(scoresPath, 'a');
    const commit = record => {
      appendLine(fd, record);
      writer.append({ type: 'record', itemId: record.id, recordDigest: record.recordDigest });
      completed += 1;
    };
    for (const row of pending) {
      const task = frozen.tasks[row.task];
      const compatibility = expectedLiveCompatibility(frozen, preregistration, row.task);
      const before = priorAttempts.get(row.id) ?? 0;
      const attempts = [];
      let scored = null;
      let outcome = null;
      for (let attempt = 0; attempt <= budget.maxRetriesPerItem && before + attempt < budget.maxAttemptsPerItemTotal; attempt += 1) {
        if (spent + reservation > ceiling) {
          if (attempts.length) commit(buildRecord({ row, task, scored, outcome: { status: 'error', reason: 'budget-ceiling' }, attempts, priorAttempts: before, compatibility, collectorInfo }));
          return summary('budget-ceiling');
        }
        // The ledger sequence number makes every reservation ID unique, including after a crash.
        const reservationId = `${row.id}#${writer.seq}`;
        writer.append({ type: 'reserve', reservationId, itemId: row.id, reservedMicros: reservation });
        spent += reservation;
        providerCalls += 1;
        let thrown = null;
        scored = null;
        try {
          scored = await scoreRowThroughRuntime({ row, task, model, region, adapter, credential });
        } catch (error) {
          thrown = error;
        }
        const charge = chargeForUsage(preregistration, scored?.usage ?? null);
        const overrun = charge.chargedMicros > reservation;
        spent += charge.chargedMicros - reservation;
        writer.append({ type: 'settle', reservationId, chargedMicros: charge.chargedMicros, basis: charge.basis, overrun });
        inputTokens += scored?.usage?.inputTokens ?? 0;
        outputTokens += scored?.usage?.outputTokens ?? 0;
        outcome = classify(scored, thrown, model);
        attempts.push({
          attempt: before + attempt + 1,
          status: outcome.status,
          reason: outcome.reason,
          requestId: scored?.requestId ?? null,
          inputTokens: scored?.usage?.inputTokens ?? null,
          outputTokens: scored?.usage?.outputTokens ?? null,
          reservedMicros: reservation,
          chargedMicros: charge.chargedMicros,
          chargeBasis: charge.basis,
        });
        if (overrun) {
          commit(buildRecord({ row, task, scored, outcome, attempts, priorAttempts: before, compatibility, collectorInfo }));
          writer.append({ type: 'halt', reason: 'reservation-overrun', reservationId });
          return summary('reservation-overrun');
        }
        if (outcome.status !== 'error') break;
      }
      commit(buildRecord({ row, task, scored, outcome, attempts, priorAttempts: before, compatibility, collectorInfo }));
      consecutiveErrors = outcome.status === 'error' ? consecutiveErrors + 1 : 0;
      if (consecutiveErrors >= budget.maxConsecutiveErrors) return summary('consecutive-errors');
    }
    return summary(null);
  } finally {
    if (fd !== null) closeSync(fd);
    writer?.close();
    release();
  }
}

function defaultStateDir(env = process.env) {
  const stateRoot = env.XDG_STATE_HOME ?? (env.HOME ? join(env.HOME, '.local/state') : '/tmp');
  return join(stateRoot, 'aiwg/conformal-2613');
}

export async function main(env = process.env, argv = process.argv.slice(2), hooks = {}) {
  const parsed = parseArgs(argv);
  const preregistration = JSON.parse(readFileSync(new URL('preregister.v2.json', root), 'utf8'));
  const frozen = JSON.parse(readFileSync(new URL('frozen.v2.json', root), 'utf8'));
  verifyFrozenOpenData(frozen, preregistration);
  const budget = preregistration.resourceBudget;
  const pinnedModel = preregistration.pins.liveServedModel;
  const model = argValue(parsed, '--model', pinnedModel);
  if (model !== pinnedModel) throw new Error(`--model must equal the pinned live served model '${pinnedModel}'`);
  const stateDir = argValue(parsed, '--state-dir', defaultStateDir(env));
  const all = liveSubsetRows(frozen);
  const limit = Number(argValue(parsed, '--limit', String(all.length)));
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
  const rows = all.slice(0, limit);
  const { spentMicros, halted } = experimentSpendMicros(stateDir);
  const estimate = estimateCollection(preregistration, rows.length, spentMicros);
  const live = parsed.flags.has('--live');
  const attestation = `${budget.inputUsdPerMillionTokensCeiling}/${budget.outputUsdPerMillionTokensCeiling}`;
  const plan = {
    schemaVersion: 'conformal-jev-collection-plan/v2',
    issue: 2613,
    mode: live ? 'live-requested' : 'dry-run',
    envGateSet: env.AIWG_DECISION_JEV_LIVE_SMOKE === '1',
    credentialConfigured: Boolean(env.AIWG_DECISION_JEV_API_KEY),
    regionConfigured: Boolean(env.AIWG_DECISION_JEV_REGION),
    priceCeilingAttested: env.AIWG_DECISION_JEV_PRICE_CEILING_ATTESTED === attestation,
    model,
    liveSubsetHashes: frozen.liveSubsets.hashes,
    rows: rows.length,
    estimate,
    ledgerHalted: halted,
    stateDir,
    noCallsMade: !live,
  };
  if (!live) {
    console.log(JSON.stringify(plan, null, 2));
    return plan;
  }
  if (env.AIWG_DECISION_JEV_LIVE_SMOKE !== '1') throw new Error('AIWG_DECISION_JEV_LIVE_SMOKE=1 is required for live collection');
  if (!env.AIWG_DECISION_JEV_API_KEY) throw new Error('AIWG_DECISION_JEV_API_KEY is required for live collection');
  if (!env.AIWG_DECISION_JEV_REGION) throw new Error('AIWG_DECISION_JEV_REGION is required for D10 projection authorization');
  if (env.AIWG_DECISION_JEV_PRICE_CEILING_ATTESTED !== attestation) {
    throw new Error(`AIWG_DECISION_JEV_PRICE_CEILING_ATTESTED=${attestation} is required: attest that the served model's input/output USD per million tokens do not exceed the preregistered ceiling`);
  }
  const adapter = hooks.adapter ?? new JevDecisionAdapter({ region: env.AIWG_DECISION_JEV_REGION });
  const summary = await collectLiveScores({
    preregistration,
    frozen,
    rows,
    model,
    region: env.AIWG_DECISION_JEV_REGION,
    credential: env.AIWG_DECISION_JEV_API_KEY,
    stateDir,
    output: join(stateDir, SCORES_FILE),
    adapter,
  });
  console.log(JSON.stringify({ ...plan, mode: 'live-complete', noCallsMade: false, ...summary }, null, 2));
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
