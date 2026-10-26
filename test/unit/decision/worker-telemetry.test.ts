import { describe, expect, it, vi } from 'vitest';
import receipt from '../../fixtures/decision/worker-telemetry.json';
import { GEN_AI_SCHEMA_URL, mapWorkerReceipt, scanTelemetryCanaries, WorkerReceiptTelemetry,
  type DecisionTelemetryTrace } from '../../../src/decision/telemetry/index.js';

const models = ['requested-v1', 'served-v2'];
const options = { enabled: true, selection: { dataPolicy: { allowedProcessing: ['remote' as const] } },
  conductorId: 'conductor-1', runId: 'run-1', allowedModels: models };
const canaries = ['PROMPT-CANARY-2929', 'FINAL-CANARY-2929', 'ENV-CANARY-2929', 'sk-proj-2929-secret-key'];

describe('worker receipt projection', () => {
  it('pins the convention and correlates attempts with conductor/run and a W3C parent', async () => {
    const traces: DecisionTelemetryTrace[] = [];
    const parent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: '01' as const, traceState: canaries[0] };
    const observer = new WorkerReceiptTelemetry({ ...options, parent, sink: { export: async t => { traces.push(t); } } });
    expect(observer.offer(receipt, { startTimeUnixMs: 100, endTimeUnixMs: 150 })).toBe(true);
    expect(observer.offer({ ...receipt, invocationId: 'inv-2929-retry' })).toBe(true);
    await observer.shutdown();
    expect(traces).toHaveLength(2);
    expect(traces[0]?.schemaUrl).toBe(GEN_AI_SCHEMA_URL);
    const span = traces[0]!.spans[0]!;
    expect(span).toMatchObject({ name: 'worker.attempt', parentSpanId: parent.spanId,
      startTimeUnixMs: 100, endTimeUnixMs: 150, status: 'unset' });
    expect(span.context).toMatchObject({ traceId: parent.traceId });
    expect(span.context).not.toHaveProperty('traceState');
    expect(span.attributes).toMatchObject({ 'aiwg.otel.gen_ai_semconv_revision': '1.37.0',
      'gen_ai.request.model': 'requested-v1', 'gen_ai.response.model': 'served-v2',
      'gen_ai.usage.input_tokens': 12, 'aiwg.usage.input_tokens_provenance': 'provider-fact' });
    const second = traces[1]!.spans[0]!;
    for (const key of ['aiwg.conductor.id', 'aiwg.run.id', 'aiwg.task.id']) {
      expect(span.attributes[key]).toMatch(/^[0-9a-f]{64}$/);
      expect(second.attributes[key]).toBe(span.attributes[key]);
    }
    expect(second.attributes['aiwg.invocation.id']).not.toBe(span.attributes['aiwg.invocation.id']);
    expect(second.context.spanId).not.toBe(span.context.spanId);
    expect(span.events).toEqual([{ name: 'attempt.terminated', timeUnixMs: 150,
      attributes: { 'aiwg.worker.termination': 'confirmed' } }]);
    expect(span.links).toEqual([]);
  });

  it('keeps reported, estimated, missing and unknown usage distinct without requested-model fallback', () => {
    const unknown = mapWorkerReceipt({ ...receipt, observed: null,
      usage: { quality: 'unknown', inputTokens: 999, outputTokens: 0, costUsd: 2 } }, options, models);
    expect(unknown.attributes['gen_ai.response.model']).toBeNull();
    expect(unknown.provenance['gen_ai.response.model']).toBe('unknown');
    for (const key of ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'aiwg.usage.cost_usd']) {
      expect(unknown.attributes[key]).toBeNull();
      expect(unknown.provenance[key]).toBe('unknown');
    }
    const estimated = mapWorkerReceipt({ ...receipt, identityConfidence: 'runtime-configured-only',
      usage: { quality: 'estimated', inputTokens: 0, outputTokens: null, costUsd: 0.1 } }, options, models);
    expect(estimated.attributes['gen_ai.usage.input_tokens']).toBe(0);
    expect(estimated.attributes['aiwg.usage.input_tokens_provenance']).toBe('estimate');
    expect(estimated.provenance['gen_ai.response.model']).toBe('client-derived');
    expect(estimated.provenance['gen_ai.usage.output_tokens']).toBe('unknown');
    expect(mapWorkerReceipt({}, options).attributes['gen_ai.usage.input_tokens']).toBeNull();
    expect(mapWorkerReceipt({ ...receipt, usage: { quality: 'reported', inputTokens: NaN,
      outputTokens: -1, costUsd: Infinity } }, options).attributes['aiwg.usage.cost_usd']).toBeNull();
  });

  it('exports no prompt/final/env/secret content even when planted in allowed metadata positions', async () => {
    const traces: DecisionTelemetryTrace[] = [];
    const observer = new WorkerReceiptTelemetry({ ...options, conductorId: canaries[0]!, runId: canaries[1]!,
      // Even an accidentally operator-listed secret-shaped model is suppressed.
      allowedModels: [...models, canaries[3]!], sink: { export: async t => { traces.push(t); throw new Error(canaries.join(' ')); } } });
    const hostile = { ...receipt, taskId: canaries[2], invocationId: canaries[3],
      requested: { model: canaries[3] }, observed: { model: canaries[0] },
      prompt: canaries[0], brief: canaries[0], final: canaries[1], env: { TOKEN: canaries[2] },
      attributes: { 'aiwg.run.id': canaries[0] }, events: [{ name: canaries[1] }], links: [{ traceId: canaries[2] }] };
    expect(observer.offer(hostile)).toBe(true);
    await observer.shutdown();
    expect(scanTelemetryCanaries({ traces, diagnostics: observer.diagnostics }, canaries)).toEqual([]);
    expect(observer.diagnostics[0]?.detail).toBe('telemetry export failed');
  });

  it.each([
    {}, { enabled: false },
    { enabled: true, selection: undefined },
    { enabled: true, selection: { dataPolicy: { allowedProcessing: ['local'] } } },
    { enabled: true, selection: { dataPolicy: { allowedProcessing: ['remote'] }, dataClasses: {
      private: { allowedProcessing: ['local'] } } }, dataClass: 'private' },
    { enabled: true, dataClass: 'unknown' },
    { enabled: true, selection: { dataPolicy: { allowedProcessing: ['remote'] }, dataClasses: {} }, dataClass: 'constructor' },
  ])('suppresses export before reading evidence for off, local-only or unknown policy: %j', async override => {
    const sink = { export: vi.fn(async () => {}) };
    const observer = new WorkerReceiptTelemetry({ ...options, enabled: undefined, ...override, sink } as ConstructorParameters<typeof WorkerReceiptTelemetry>[0]);
    let read = false;
    const hostile = { get taskId() { read = true; throw new Error('must not map'); } };
    expect(observer.offer(hostile)).toBe(false);
    await observer.shutdown();
    expect(read).toBe(false);
    expect(sink.export).not.toHaveBeenCalled();
    expect(observer.diagnostics).toEqual([]);
  });

  it('requires a sink and snapshots host policy so worker fields cannot grant egress', async () => {
    const absent = new WorkerReceiptTelemetry(options);
    expect(absent.offer(receipt)).toBe(false);
    const selection = { dataPolicy: { allowedProcessing: ['local' as 'local' | 'remote'] } };
    const sink = { export: vi.fn(async () => {}) };
    const observer = new WorkerReceiptTelemetry({ ...options, selection, sink });
    selection.dataPolicy.allowedProcessing.push('remote');
    expect(observer.offer({ ...receipt, selection: options.selection } as typeof receipt)).toBe(false);
    await observer.shutdown();
    expect(sink.export).not.toHaveBeenCalled();
  });

  it('rejects malformed times/parents and stops accepting telemetry after shutdown', async () => {
    const sink = { export: vi.fn(async () => {}) };
    const observer = new WorkerReceiptTelemetry({ ...options, sink });
    expect(observer.offer(receipt, { startTimeUnixMs: 2, endTimeUnixMs: 1 })).toBe(false);
    expect(observer.offer(receipt, { startTimeUnixMs: NaN, endTimeUnixMs: Infinity })).toBe(false);
    const bad = new WorkerReceiptTelemetry({ ...options, sink, parent: {
      traceId: 'secret', spanId: 'secret', traceFlags: '01' } });
    expect(bad.offer(receipt)).toBe(false);
    await observer.shutdown();
    expect(observer.offer(receipt)).toBe(false);
    expect(sink.export).not.toHaveBeenCalled();
  });
});
