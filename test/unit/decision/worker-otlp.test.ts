import { describe, expect, it, vi } from 'vitest';
import receipt from '../../fixtures/decision/worker-telemetry.json';
import { DecisionOtlpHttpSink, GEN_AI_SCHEMA_URL, WorkerReceiptTelemetry } from '../../../src/decision/telemetry/index.js';

const options = { enabled: true, conductorId: 'conductor', runId: 'run', allowedModels: ['requested-v1', 'served-v2'],
  selection: { dataPolicy: { allowedProcessing: ['remote' as const] } } };

describe('worker OTLP projection', () => {
  it('exports a revision-pinned OTLP scope with provenance and no unknown GenAI measurement', async () => {
    const bodies: string[] = [];
    const transport = vi.fn(async (_url, init) => { bodies.push(String(init?.body)); return new Response(null, { status: 204 }); }) as typeof fetch;
    const sink = new DecisionOtlpHttpSink({ endpoint: 'https://collector.example/v1/traces', maxPayloadBytes: 16_384, fetch: transport });
    const observer = new WorkerReceiptTelemetry({ ...options, sink });
    expect(observer.offer({ ...receipt, observed: null, usage: { quality: 'unknown', inputTokens: 999 } })).toBe(true);
    await observer.shutdown();
    const scope = JSON.parse(bodies[0]!).resourceSpans[0].scopeSpans[0];
    expect(scope).toMatchObject({ schemaUrl: GEN_AI_SCHEMA_URL, scope: { name: 'aiwg.worker', version: '1' } });
    const attributes = Object.fromEntries(scope.spans[0].attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]));
    expect(attributes['gen_ai.request.model']).toEqual({ stringValue: 'requested-v1' });
    expect(attributes).not.toHaveProperty('gen_ai.response.model');
    expect(attributes).not.toHaveProperty('gen_ai.usage.input_tokens');
    expect(attributes).not.toHaveProperty('gen_ai.usage.output_tokens');
    expect(attributes['aiwg.usage.quality']).toEqual({ stringValue: 'unknown' });
    expect(attributes['aiwg.usage.input_tokens_provenance']).toEqual({ stringValue: 'unknown' });
    expect(transport).toHaveBeenCalledWith('https://collector.example/v1/traces', expect.objectContaining({ redirect: 'manual' }));
  });

  it('keeps estimated usage numeric and marks its provenance on the wire', async () => {
    let payload = '';
    const sink = new DecisionOtlpHttpSink({ endpoint: 'https://collector.example/v1/traces', maxPayloadBytes: 16_384,
      fetch: vi.fn(async (_url, init) => { payload = String(init?.body); return new Response(null, { status: 204 }); }) as typeof fetch });
    const observer = new WorkerReceiptTelemetry({ ...options, sink });
    observer.offer({ ...receipt, usage: { quality: 'estimated', inputTokens: 0, outputTokens: 3 } });
    await observer.shutdown();
    const attributes = JSON.parse(payload).resourceSpans[0].scopeSpans[0].spans[0].attributes;
    expect(attributes).toContainEqual({ key: 'gen_ai.usage.input_tokens', value: { intValue: '0' } });
    expect(attributes).toContainEqual({ key: 'aiwg.usage.input_tokens_provenance', value: { stringValue: 'estimate' } });
  });

  it('never calls a validated HTTPS collector for a local-only task', async () => {
    const transport = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;
    const sink = new DecisionOtlpHttpSink({ endpoint: 'https://collector.example/v1/traces', maxPayloadBytes: 16_384, fetch: transport });
    const observer = new WorkerReceiptTelemetry({ ...options, sink,
      selection: { dataPolicy: { allowedProcessing: ['local'] } } });
    expect(observer.offer(receipt)).toBe(false);
    await observer.shutdown();
    expect(transport).not.toHaveBeenCalled();
  });

  it('bounds serialized worker traces before collector access', async () => {
    const sink = { export: vi.fn(async () => {}) };
    const observer = new WorkerReceiptTelemetry({ ...options, sink, maximumTraceBytes: 100 });
    expect(observer.offer(receipt)).toBe(false);
    await observer.shutdown();
    expect(sink.export).not.toHaveBeenCalled();
    expect(observer.diagnostics).toEqual([expect.objectContaining({ type: 'dropped' })]);
  });
});
