// Follow a native source through the importer's normalization and checkpoint rules.
import { setTimeout } from 'node:timers/promises';
import { SessionContractError, assertSessionResourceLimit, assertSupportedSchemaMajor,
  sha256, type ImportCheckpoint, type SessionEvent } from './contracts.js';
import { IncrementalSessionImporter, type ImportRequest } from './importer.js';
import { normalizeSessionBatch } from './normalization.js';
import { assertImportByteLimit, DEFAULT_IMPORT_BYTE_LIMITS } from './import-limits.js';
import type { SessionRepositoryPort } from './ports.js';

export interface SessionTailOptions extends ImportRequest {
  repository: SessionRepositoryPort;
  sessionId: string;
  follow?: boolean;
  import?: boolean;
  pollMs?: number;
  onEvent(event: SessionEvent): void;
  /** Allows the CLI to drain stdout before reading another source snapshot. */
  onPoll?(): Promise<void>;
}

export function assertTailSupported(adapter: ImportRequest['adapter']): void {
  if (typeof adapter.stream !== 'function' || !adapter.supportedOperations.includes('stream')) {
    throw new SessionContractError('UNSUPPORTED_PROVIDER',
      `sessions tail is unsupported for provider ${adapter.provider}: adapter has no stream operation`);
  }
}

export async function tailSession(options: SessionTailOptions): Promise<void> {
  assertTailSupported(options.adapter);
  assertSupportedSchemaMajor(options.source.sourceSchemaVersion, options.adapter.sourceSchemaMajor ?? 1);
  if (options.workspaceId !== options.selectedSource.authorizedScope.workspaceId) {
    throw new SessionContractError('SOURCE_NOT_AUTHORIZED', 'tail workspace is outside the authorized source scope');
  }
  const pollMs = options.pollMs ?? 500;
  if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 500) {
    throw new SessionContractError('INVALID_ARGUMENT', 'tail poll interval must be between 1 and 500 ms');
  }
  let checkpoint: ImportCheckpoint | null = options.repository.getCheckpoint(
    options.source.sourceId, options.adapter.adapterVersion,
  );
  const port: SessionRepositoryPort = {
    getCheckpoint: () => checkpoint,
    getBatchCheckpoint: () => null,
    commitStagedImports: () => 0,
    applyImport: (batch, next) => {
      // Publish through the existing import transaction only with explicit opt-in.
      const receipt = options.repository.applyImport(batch, next, true);
      checkpoint = { ...next };
      for (const event of batch.events) {
        if (event.sessionId === options.sessionId) options.onEvent(event);
      }
      return receipt;
    },
  };
  const importer = new IncrementalSessionImporter(port);
  while (!options.signal?.aborted) {
    try {
      if (options.import) {
        await importer.import({
          ...options, publish: true, batchRunId: undefined,
          limits: { ...options.limits, batchSize: 1 },
        });
      } else {
        // Do not fingerprint or persist snapshots: export adapters may rewrite
        // a JSON document as it grows. Each adapter owns its resume semantics.
        for await (const record of options.adapter.stream(options.selectedSource,
          checkpoint ? { value: checkpoint.cursor } : undefined)) {
          if (options.signal?.aborted) return;
          const serialized = JSON.stringify(record);
          const limits = { ...DEFAULT_IMPORT_BYTE_LIMITS, ...options.limits };
          assertImportByteLimit('maxRecordBytes', limits, Buffer.byteLength(serialized));
          const count = (checkpoint?.recordsRead ?? 0) + 1;
          assertSessionResourceLimit('maxRecords', options.limits?.maxRecords ?? 1_000_000, count);
          const digest = sha256(serialized);
          const runId = sha256([options.source.sourceId, options.adapter.adapterVersion,
            count - 1, count, digest].join('\0'));
          const { events } = normalizeSessionBatch(options, [record], [digest], runId);
          checkpoint = { ...checkpoint, cursor: record.sourceCursor ?? String(count),
            recordsRead: count, bytesRead: (checkpoint?.bytesRead ?? 0) + Buffer.byteLength(serialized) };
          for (const event of events) {
            if (event.sessionId === options.sessionId) options.onEvent(event);
          }
        }
      }
    } catch (error) {
      if (options.signal?.aborted) return;
      // Some native JSONL adapters report an in-progress final line explicitly.
      if (!(options.follow && error instanceof SessionContractError
        && error.code === 'TRUNCATED_SOURCE')) throw error;
    }
    await options.onPoll?.();
    if (!options.follow || options.signal?.aborted) return;
    try { await setTimeout(pollMs, undefined, { signal: options.signal }); }
    catch (error) { if (!options.signal?.aborted) throw error; }
  }
}
