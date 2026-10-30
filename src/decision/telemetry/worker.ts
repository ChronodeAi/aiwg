// Optional metadata projection of existing dispatch receipts through the bounded exporter.
import type { WorkerSelectionPolicy } from '../../models/types.js';
import { createTelemetryContext, extractTraceContext } from './context.js';
import { BoundedDecisionTraceExporter, type DecisionTraceSink } from './exporter.js';
import { mapWorkerReceipt, type WorkerReceiptEvidence } from './mapping.js';
import { DECISION_TELEMETRY_SCHEMA_VERSION, GEN_AI_SCHEMA_URL, type DecisionTelemetryContext,
  type DecisionTelemetrySpan } from './types.js';

export interface WorkerReceiptProjectionOptions {
  enabled?: boolean;
  sink?: DecisionTraceSink;
  /** Trusted host policy, including any task data-class restriction; never taken from a receipt. */
  selection?: Pick<WorkerSelectionPolicy, 'dataPolicy' | 'dataClasses'>;
  dataClass?: string;
  conductorId: string;
  runId: string;
  parent?: DecisionTelemetryContext;
  /** Explicit operator model-name allowlist, never populated from worker output. */
  allowedModels?: readonly string[];
  capacity?: number;
  timeoutMs?: number;
  maximumTraceBytes?: number;
  maximumDiagnostics?: number;
  canaries?: readonly string[];
}

/** Optional observer for attempts sharing one task policy; retains no receipts or completion state. */
export class WorkerReceiptTelemetry {
  private readonly exporter?: BoundedDecisionTraceExporter;
  private readonly options: WorkerReceiptProjectionOptions;
  private readonly root: DecisionTelemetryContext;

  constructor(options: WorkerReceiptProjectionOptions) {
    this.options = structuredClone({ ...options, sink: undefined });
    this.root = createTelemetryContext();
    if (options.enabled === true && options.sink) {
      this.exporter = new BoundedDecisionTraceExporter(options.sink, {
        capacity: options.capacity ?? 32, timeoutMs: options.timeoutMs ?? 1000,
        maximumTraceBytes: options.maximumTraceBytes, maximumDiagnostics: options.maximumDiagnostics,
        canaries: options.canaries, redactErrors: true,
      });
    }
  }

  get diagnostics() { return this.exporter?.diagnostics ?? []; }

  /** Gate before mapping or enqueue. Unknown policy and local-only tasks suppress all export. */
  offer(receipt: WorkerReceiptEvidence, timing?: { startTimeUnixMs: number; endTimeUnixMs: number }): boolean {
    try {
      if (!this.exporter || !this.externalExportAllowed()) return false;
      const now = Date.now();
      const start = timing?.startTimeUnixMs ?? now;
      const end = timing?.endTimeUnixMs ?? now;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return false;
      const parent = this.options.parent;
      const safeParent = parent ? extractTraceContext({ traceparent: `00-${parent.traceId}-${parent.spanId}-${parent.traceFlags}` }) : null;
      if (parent && !safeParent) return false;
      const context = createTelemetryContext(undefined, safeParent ?? this.root);
      const mapped = mapWorkerReceipt(receipt, this.options, this.options.allowedModels);
      const span: DecisionTelemetrySpan = {
        schemaVersion: DECISION_TELEMETRY_SCHEMA_VERSION, name: 'worker.attempt', context,
        parentSpanId: safeParent?.spanId ?? null, startTimeUnixMs: start, endTimeUnixMs: end,
        // A confirmed stop is not proof of acceptance or success.
        status: 'unset', attributes: mapped.attributes, provenance: mapped.provenance, links: [],
        events: [{ name: 'attempt.terminated', timeUnixMs: end, attributes: {
          'aiwg.worker.termination': mapped.attributes['aiwg.worker.termination'] ?? null,
        } }],
      };
      return this.exporter.offer({ schemaVersion: DECISION_TELEMETRY_SCHEMA_VERSION,
        schemaUrl: GEN_AI_SCHEMA_URL, traceId: context.traceId, spans: [span] });
    } catch { return false; }
  }

  async shutdown(): Promise<void> { await this.exporter?.shutdown(); }

  private externalExportAllowed(): boolean {
    const selection = this.options.selection;
    if (!selection?.dataPolicy?.allowedProcessing?.includes('remote')) return false;
    if (this.options.dataClass !== undefined) {
      if (!selection.dataClasses || !Object.hasOwn(selection.dataClasses, this.options.dataClass)) return false;
      const narrowed = selection.dataClasses?.[this.options.dataClass];
      if (!narrowed || (narrowed.allowedProcessing !== undefined && !narrowed.allowedProcessing.includes('remote'))) return false;
    }
    return true;
  }
}
