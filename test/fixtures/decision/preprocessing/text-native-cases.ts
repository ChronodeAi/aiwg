/**
 * Text-native decision requests with NO preprocessing manifest (D24 AC12).
 *
 * The same module runs against two runtimes: origin/main's `src/decision` to capture
 * `text-native-golden-v1.json`, and the current runtime in
 * `test/unit/decision/preprocessed-evidence.test.ts`. Keep it runtime-agnostic: every
 * runtime export is passed in, and nothing here imports `src/decision`.
 */
import { readFileSync } from 'node:fs';

interface Runtime {
  evaluateDecisionRuleset: (request: never) => Promise<unknown>;
  MemoryDecisionReceiptStore: new () => { read(invocationId: string, projectId?: string): Promise<unknown> };
}

export interface TextNativeCaseOutput {
  id: string;
  result: unknown;
  receipt: unknown;
  dispatched: unknown[];
  credentialCalls: number;
}

export const TEXT_NATIVE_EPOCH_MS = 1_790_000_000_000;

const addon = (name: string): unknown =>
  JSON.parse(readFileSync(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8'));

function adapter(seen: unknown[], egress: 'network' | 'none') {
  const success = (value: string | number, profile = 'typesafe-distribution-v1') => ({
    status: 'success', reason: 'none', value,
    uncertainty: { source: 'provider', profile, calibration: 'vendor-claimed', confidence: 0.9, distribution: null, calibrationRef: null },
    actualModel: 'fixture-model', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, requestId: 'fixture-request',
  });
  return {
    id: 'jev', version: '1.0.0',
    capabilities: async () => ({
      answerKinds: ['choice', 'ordinal-score', 'truth-probability'],
      features: ['choice', 'ordinal-score', 'truth-probability'],
      maxOptions: 255, maxLevels: 10, confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'],
      executable: true,
      egress: egress === 'network' ? { mode: 'network', origin: 'https://api.typesafe.ai', region: 'us' } : { mode: 'none' },
    }),
    evaluate: async (request: { alias: string; input: unknown; projectionEvidence?: unknown }) => {
      seen.push(JSON.parse(JSON.stringify({ alias: request.alias, input: request.input,
        projectionEvidence: request.projectionEvidence ?? null })));
      if (request.alias === 'category') return success('documentation');
      if (request.alias === 'severity') return success(0.25);
      return success(0.05, 'typesafe-truth-v1');
    },
  };
}

function projectionPolicy() {
  return {
    version: '1.0.0', provider: 'jev', model: 'jev-latest', origin: 'https://api.typesafe.ai', region: 'us',
    purpose: 'triage', allowIncompleteContext: false,
    fields: [{
      pointer: '/message', output: 'message', source: 'user-message', subject: 'case-text-native',
      trust: 'untrusted', sensitivity: 'internal', purpose: 'triage', retentionClass: 'ephemeral',
      accessScopes: ['decision-runtime'], exportPolicy: 'denied', deletionPolicy: 'erase', backupPolicy: 'not-persisted',
      allowedProviders: ['jev'], allowedModels: ['jev-latest'], allowedOrigins: ['https://api.typesafe.ai'], allowedRegions: ['us'],
    }],
  };
}

/** The request for one case. `extra` lets a caller add fields (for example an empty lineage) to the same request. */
export function textNativeRequest(runtime: Runtime, id: string, seen: unknown[], credentialCalls: { count: number },
  extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ruleset: addon('ruleset.json'),
    binding: addon('binding-jev.json'),
    definitions: {
      category: addon('decision-category.json'),
      severity: addon('decision-severity.json'),
      core: addon('decision-core_unavailable.json'),
    },
    input: addon('input.json'),
    runId: 'text-native-golden',
    invocationId: `text-native-${id}`,
    now: () => TEXT_NATIVE_EPOCH_MS,
  };
  if (id === 'local-no-egress') return { ...base, adapters: { jev: adapter(seen, 'none') }, ...extra };
  if (id === 'local-receipt-store') {
    return { ...base, adapters: { jev: adapter(seen, 'none') }, receiptStore: new runtime.MemoryDecisionReceiptStore(), ...extra };
  }
  return {
    ...base,
    adapters: { jev: adapter(seen, 'network') },
    projection: { resolve: () => projectionPolicy() },
    resolveCredential: async () => { credentialCalls.count += 1; return new Uint8Array([1]); },
    ...extra,
  };
}

export const TEXT_NATIVE_CASE_IDS = ['local-no-egress', 'local-receipt-store', 'network-projected'] as const;

/**
 * Run every case with `Date.now` frozen so receipt timestamps are reproducible.
 * `extra` is merged into every request (used to prove an empty lineage is inert).
 */
export async function runTextNativeCases(runtime: Runtime, extra: Record<string, unknown> = {}): Promise<TextNativeCaseOutput[]> {
  const realNow = Date.now;
  Date.now = () => TEXT_NATIVE_EPOCH_MS;
  try {
    const outputs: TextNativeCaseOutput[] = [];
    for (const id of TEXT_NATIVE_CASE_IDS) {
      const seen: unknown[] = [];
      const credentialCalls = { count: 0 };
      const request = textNativeRequest(runtime, id, seen, credentialCalls, extra);
      const result = await runtime.evaluateDecisionRuleset(request as never);
      const store = request.receiptStore as InstanceType<Runtime['MemoryDecisionReceiptStore']> | undefined;
      const receipt = store ? await store.read(request.invocationId as string, 'default') : null;
      outputs.push({ id, result, receipt, dispatched: seen, credentialCalls: credentialCalls.count });
    }
    return outputs;
  } finally {
    Date.now = realNow;
  }
}
