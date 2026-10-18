import { z } from 'zod';
import {
  schemaRejectionDetail,
  schemaIssueDetail,
  SessionContractError,
  assertSupportedSchemaMajor,
  type ImportCursor,
  type ProviderRecord,
  type SelectedSource,
  type SessionSourceAdapter,
  type SourceDescriptor,
  type SourceProbe,
  type AuthorizedScope,
} from '../contracts.js';
import { streamBoundedJsonLines, type ReaderLimits } from '../readers.js';

export const GENERIC_INTERCHANGE_KIND = 'aiwg.session-interchange';
export const GENERIC_ADAPTER_VERSION = '1.0.0';

const Rfc3339Schema = z.string().refine(
  (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value)),
  'timestamp must be RFC 3339 with an explicit UTC offset',
);

export const GenericInterchangeHeaderSchema = z.object({
  type: z.literal(GENERIC_INTERCHANGE_KIND),
  schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  product: z.string().min(1),
  productVersion: z.string().min(1),
  sourceId: z.string().min(1),
  exportedAt: Rfc3339Schema,
  consistency: z.enum(['provisional', 'consistent-snapshot', 'complete']),
  lifecycle: z.enum(['active', 'complete', 'archived']),
  workspace: z.object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    repository: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
  }).passthrough(),
  provenance: z.object({
    exporter: z.string().min(1),
    exporterVersion: z.string().min(1),
    sourceClass: z.string().min(1),
  }).passthrough(),
  extensions: z.record(z.unknown()).default({}),
}).passthrough();

export const GenericInterchangeEventSchema = z.object({
  type: z.literal('event'),
  sessionId: z.string().min(1),
  eventId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  kind: z.string().min(1),
  role: z.string().min(1).optional(),
  participant: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  entities: z.array(z.string().min(1)).optional(),
  extractionState: z.string().min(1).optional(),
  occurredAt: Rfc3339Schema.optional(),
  text: z.string(),
  lifecycle: z.enum(['active', 'complete', 'archived']),
  extensions: z.record(z.unknown()).default({}),
}).passthrough();

export type GenericInterchangeHeader = z.infer<typeof GenericInterchangeHeaderSchema>;

export class GenericSessionInterchangeAdapter implements SessionSourceAdapter {
  readonly provider = 'generic' as const;
  readonly adapterVersion = GENERIC_ADAPTER_VERSION;
  readonly disposition = 'manual-only' as const;
  readonly supportedOperations = ['inspect', 'stream'] as const;
  readonly acquisitionModes = ['manual-export'] as const;

  constructor(private readonly limits?: Partial<ReaderLimits>) {}

  async *discover(_scope: AuthorizedScope): AsyncIterable<SourceDescriptor> {
    throw new SessionContractError(
      'UNSUPPORTED_OPERATION',
      'generic interchange does not support automatic discovery; select an exported file explicitly',
    );
  }

  async inspect(source: SelectedSource): Promise<SourceProbe> {
    const input = await this.openStream(source);
    let header: GenericInterchangeHeader | null = null;
    const eventIds = new Set<string>();
    const sessionSequences = new Set<string>();
    for await (const record of input) {
      if (!header) {
        header = this.validateHeader(record.value, source);
        continue;
      }
      const event = parseEvent(record.value);
      if (eventIds.has(event.eventId)) {
        throw new SessionContractError(
          'DUPLICATE_NATIVE_ID',
          'generic interchange contains a duplicate event ID',
        );
      }
      eventIds.add(event.eventId);
      const sequenceKey = `${event.sessionId}\0${event.sequence}`;
      if (sessionSequences.has(sequenceKey)) {
        throw new SessionContractError(
          'DUPLICATE_NATIVE_ID',
          'generic interchange contains a duplicate session sequence',
        );
      }
      sessionSequences.add(sequenceKey);
    }
    if (!header) throw new SessionContractError('MALFORMED_SOURCE', 'generic interchange is empty', schemaIssueDetail('<root>'));
    if (input.incompleteTail) {
      throw new SessionContractError(
        'TRUNCATED_SOURCE',
        'generic interchange contains a truncated record',
      );
    }
    return {
      sourceSchemaVersion: header.schemaVersion,
      consistency: header.consistency,
      operationalState: 'available',
      declaredWorkspaceId: header.workspace.id,
    };
  }

  async *stream(source: SelectedSource, cursor?: ImportCursor): AsyncIterable<ProviderRecord> {
    const byteCursor = parseByteCursor(cursor?.value);
    let header: GenericInterchangeHeader | null = null;
    if (byteCursor !== null) {
      const headerStream = await this.openStream(source);
      const iterator = headerStream[Symbol.asyncIterator]();
      const first = await iterator.next();
      await iterator.return?.();
      if (first.done) throw new SessionContractError('MALFORMED_SOURCE', 'generic interchange is empty', schemaIssueDetail('<root>'));
      header = this.validateHeader(first.value.value, source);
    }
    const input = await this.openStream(source, byteCursor ?? undefined);
    const start = byteCursor === null ? parseEventCursor(cursor?.value) : 0;
    let eventIndex = 0;
    const eventIds = new Set<string>();
    const sessionSequences = new Set<string>();
    for await (const record of input) {
      if (!header) {
        header = this.validateHeader(record.value, source);
        continue;
      }
      const event = parseEvent(record.value);
      if (eventIds.has(event.eventId)) {
        throw new SessionContractError(
          'DUPLICATE_NATIVE_ID',
          'generic interchange contains a duplicate event ID',
        );
      }
      eventIds.add(event.eventId);
      const sequenceKey = `${event.sessionId}\0${event.sequence}`;
      if (sessionSequences.has(sequenceKey)) {
        throw new SessionContractError(
          'DUPLICATE_NATIVE_ID',
          'generic interchange contains a duplicate session sequence',
        );
      }
      sessionSequences.add(sequenceKey);
      if (eventIndex++ < start) continue;
      const knownKeys = new Set([
        'type', 'sessionId', 'eventId', 'sequence', 'kind', 'role',
        'occurredAt', 'text', 'lifecycle', 'extensions', 'participant',
        'toolName', 'toolCallId', 'model', 'entities', 'extractionState',
      ]);
      const unknownFields = Object.fromEntries(
        Object.entries(event).filter(([key]) => !knownKeys.has(key)),
      );
      yield {
        nativeSessionId: event.sessionId,
        nativeEventId: event.eventId,
        sequence: event.sequence,
        kind: event.kind,
        role: event.role,
        participant: event.participant,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        model: event.model,
        entities: event.entities,
        extractionState: event.extractionState,
        sourceCursor: `byte:${record.byteOffset + record.byteLength}`,
        sourceBytes: record.byteLength,
        occurredAt: event.occurredAt,
        text: event.text,
        rawReference: { locatorClass: 'generic-interchange', sequence: event.sequence },
        extensions: {
          ...event.extensions,
          unknownFields,
          lifecycle: event.lifecycle,
          workspace: header.workspace,
          provenance: header.provenance,
          product: header.product,
          productVersion: header.productVersion,
        },
      };
    }
    if (!header) {
      throw new SessionContractError('MALFORMED_SOURCE', 'generic interchange is empty', schemaIssueDetail('<root>'));
    }
    if (input.incompleteTail) {
      throw new SessionContractError(
        'TRUNCATED_SOURCE',
        'generic interchange contains a truncated record',
      );
    }
  }

  private openStream(source: SelectedSource, cursor?: number) {
    return streamBoundedJsonLines(
      {
        selectedPath: source.locator,
        allowedRoots: source.authorizedScope.allowedRoots,
      },
      {
        cursor: cursor === undefined ? undefined : String(cursor),
        consistency: 'provisional',
        limits: this.limits,
      },
    );
  }

  private validateHeader(value: unknown, source: SelectedSource): GenericInterchangeHeader {
    const header = parseHeader(value);
    assertSupportedSchemaMajor(header.schemaVersion);
    if (header.sourceId !== source.sourceId) {
      // SCHEMA_DRIFT: the selected identity no longer describes this file's
      // declared source, so importing it would attach events to the wrong source.
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        `selected source identity does not match interchange header: --source-id ${quoteValue(source.sourceId)} `
          + `but header sourceId is ${quoteValue(header.sourceId)}; pass --source-id ${quoteValue(header.sourceId)}`,
        schemaIssueDetail('sourceId'),
      );
    }
    return header;
  }
}

function parseByteCursor(value?: string): number | null {
  if (!value?.startsWith('byte:')) return null;
  const position = value.slice(5);
  if (!/^\d+$/.test(position)) {
    throw new SessionContractError('SCHEMA_DRIFT', 'invalid generic byte cursor', schemaIssueDetail('cursor'));
  }
  return Number(position);
}

function parseHeader(value: unknown): GenericInterchangeHeader {
  const result = GenericInterchangeHeaderSchema.safeParse(value);
  if (result.success) return result.data;
  if (hasAmbiguousTimestamp(result.error)) {
    throw new SessionContractError('AMBIGUOUS_TIMESTAMP', 'generic interchange header has an ambiguous timestamp');
  }
  if (!isDeclaredInterchange(value)) {
    throw new SessionContractError(
      'MALFORMED_SOURCE',
      'input is not a declared AIWG generic session interchange',
      schemaRejectionDetail(result.error),
    );
  }
  throw new SessionContractError(
    'MALFORMED_SOURCE',
    `generic interchange header ${describeIssue(result.error, true)}`,
    schemaRejectionDetail(result.error),
  );
}

function parseEvent(value: unknown): z.infer<typeof GenericInterchangeEventSchema> {
  const result = GenericInterchangeEventSchema.safeParse(value);
  if (result.success) return result.data;
  if (hasAmbiguousTimestamp(result.error)) {
    throw new SessionContractError('AMBIGUOUS_TIMESTAMP', 'generic interchange event has an ambiguous timestamp');
  }
  // Event values can carry transcript content, so name the field and the
  // expected shape without echoing the received value.
  throw new SessionContractError(
    'MALFORMED_SOURCE',
    `generic interchange event is malformed: ${describeIssue(result.error, false)}`,
    schemaRejectionDetail(result.error),
  );
}

function isDeclaredInterchange(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === GENERIC_INTERCHANGE_KIND;
}

function quoteValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return JSON.stringify(text.length > 64 ? `${text.slice(0, 64)}…` : text);
}

function describeIssue(error: z.ZodError, echoReceived: boolean): string {
  const issue = error.issues[0];
  const field = issue.path.length > 0 ? `field "${issue.path.join('.')}"` : 'record';
  if (issue.code === z.ZodIssueCode.invalid_enum_value) {
    const received = echoReceived ? ` (got ${quoteValue(issue.received)})` : '';
    return `${field} must be one of ${issue.options.join('|')}${received}`;
  }
  if (issue.code === z.ZodIssueCode.invalid_type) {
    return issue.received === 'undefined'
      ? `${field} is required (${issue.expected})`
      : `${field} must be ${issue.expected} (got ${issue.received})`;
  }
  if (issue.code === z.ZodIssueCode.invalid_literal) {
    return `${field} must be ${quoteValue(issue.expected)}`;
  }
  return `${field} is invalid: ${issue.message}`;
}

function hasAmbiguousTimestamp(error: z.ZodError): boolean {
  return error.issues.some((issue) =>
    issue.code === z.ZodIssueCode.custom
    && (issue.path.at(-1) === 'occurredAt' || issue.path.at(-1) === 'exportedAt'));
}

function parseEventCursor(value?: string): number {
  if (value === undefined || value === '') return 0;
  if (!/^\d+$/.test(value)) throw new SessionContractError('SCHEMA_DRIFT', 'generic event cursor is invalid', schemaIssueDetail('cursor'));
  return Number(value);
}
