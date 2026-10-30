// Native Grok Build session-store reader (synthetic schema v1; real stores never inspected).
import { opendir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { integer, number } from '../../schema/zod-validation.mjs';
import {
  schemaIssueDetail,
  schemaRejectionDetail,
  SessionContractError,
  assertSupportedSchemaMajor,
  type ProviderRecord,
  type SelectedSource,
  type SourceDescriptor,
} from '../contracts.js';
import { matchSessionWorkspace, type WorkspaceMatchKind } from '../workspace-matching.js';
import { authorizeSourceFile } from '../policy.js';
import {
  streamBoundedJsonLines,
  type BoundedJsonRecord,
  type ReaderLimits,
} from '../readers.js';

export const GROK_BUILD_NATIVE_SCHEMA_VERSION = '1.0.0';
export const GROK_BUILD_NATIVE_SCHEMA_MAJOR = 1;
export const GROK_BUILD_NATIVE_LOCATOR_CLASS = 'grok-build-native-chat-history';
export const GROK_BUILD_NATIVE_SESSION_FILENAME = 'chat_history.jsonl';
export const GROK_BUILD_ACTIVE_SESSIONS_SCHEMA_VERSION = 1;
export const GROK_BUILD_ACTIVE_FRESHNESS_MS = 120_000;
export const GROK_BUILD_NATIVE_DISCOVERY_MAX_FILES = 10_000;
const ACTIVE_SESSIONS_MAX_BYTES = 1024 * 1024;

export function grokBuildNativeEnabled(): boolean {
  return process.env.AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL === '1';
}

/** One availability message for native readers, discovery and CLI capability reports. */
export function grokBuildNativeAvailability() {
  const enabled = grokBuildNativeEnabled();
  return {
    reasonCode: enabled ? 'GROK_BUILD_NATIVE_EXPERIMENTAL_ENABLED' : 'GROK_BUILD_NATIVE_EXPERIMENTAL_DISABLED',
    remediation: `Grok Build native ingestion is experimental and ${enabled ? 'enabled but' : 'disabled by default because it is'} `
      + 'unqualified: no released-binary schema or version range is qualified. '
      + 'AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL=1 opts in to synthetic v1 chat_history.jsonl and active_sessions.json only; '
      + 'authorize the sessions root separately with --grok-root and the optional registry file with --grok-active-sessions. '
      + 'Use `grok export <session-id> <session-id>.md` and import the authorized Markdown file for the documented CLI path.',
  };
}

export function assertGrokBuildNativeEnabled(): void {
  if (!grokBuildNativeEnabled()) {
    throw new SessionContractError('UNSUPPORTED_OPERATION', grokBuildNativeAvailability().remediation);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Synthetic native record shape (v1): one JSON object per line. Real
// chat_history.jsonl schemas are unqualified (real stores are never read),
// so any record outside this shape fails closed with SCHEMA_DRIFT.
const NativeRecordSchema = z.looseObject({
  schemaVersion: z.union([z.string(), z.number()]),
  sessionId: z.string().regex(UUID),
  seq: integer().nonnegative(),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string(),
  timestamp: number().optional(),
  toolName: z.string().min(1).optional(),
  toolCallId: z.string().optional(),
  id: z.string().min(1).optional(),
});

type NativeRecord = z.infer<typeof NativeRecordSchema>;

const ActiveSessionsSchema = z.looseObject({
  schemaVersion: z.union([z.string(), z.number()]),
  sessions: z.array(z.looseObject({
    sessionId: z.string().regex(UUID),
    cwd: z.string().optional(),
    lastHeartbeatAt: number().optional(),
  })),
});

export type GrokBuildActiveRegistry = z.infer<typeof ActiveSessionsSchema>;

export interface GrokBuildLiveEvidence {
  state: 'active' | 'unknown';
  basis: 'grok-active-sessions' | 'none';
  reasonCode: string;
}

/** Decode a url-encoded cwd directory name exactly once; null means skip. */
export function decodeGrokBuildWorkspaceDir(name: string): string | null {
  if (!name || name.includes('/') || name.includes('\\')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.includes('\0')) return null;
  return decoded;
}

export function grokBuildNativeSessionId(locator: string): string | null {
  const sessionId = dirname(locator).split('/').pop()?.split('\\').pop() ?? '';
  return UUID.test(sessionId) ? sessionId.toLowerCase() : null;
}

/** Enumerate documented `<root>/<url-encoded cwd>/<id>/chat_history.jsonl` paths. */
export async function* discoverGrokBuildNativeChatHistories(
  root: string,
  maxFiles = GROK_BUILD_NATIVE_DISCOVERY_MAX_FILES,
): AsyncGenerator<SourceDescriptor> {
  assertGrokBuildNativeEnabled();
  const resolved = resolve(root);
  let workspaces;
  try {
    workspaces = await opendir(resolved);
  } catch {
    return;
  }
  let count = 0;
  for await (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const decoded = decodeGrokBuildWorkspaceDir(workspace.name);
    if (!decoded) continue;
    const workspacePath = resolve(resolved, workspace.name);
    if (workspacePath !== resolved && !workspacePath.startsWith(`${resolved}/`)) continue;
    let sessions;
    try {
      sessions = await opendir(workspacePath);
    } catch {
      continue;
    }
    for await (const session of sessions) {
      if (!session.isDirectory() || !UUID.test(session.name)) continue;
      const sessionPath = resolve(workspacePath, session.name);
      if (!sessionPath.startsWith(`${workspacePath}/`)) continue;
      let entries;
      try {
        entries = await opendir(sessionPath);
      } catch {
        continue;
      }
      for await (const entry of entries) {
        if (!entry.isFile() || entry.name !== GROK_BUILD_NATIVE_SESSION_FILENAME) continue;
        if (++count > maxFiles) {
          throw new SessionContractError(
            'RESOURCE_LIMIT_EXCEEDED',
            'Grok Build native session discovery exceeded the authorized file limit',
            { limit: 'maxFiles', configured: maxFiles, observed: count },
          );
        }
        yield {
          provider: 'grok-build',
          locator: resolve(sessionPath, entry.name),
          locatorClass: GROK_BUILD_NATIVE_LOCATOR_CLASS,
          nativeSessionId: session.name.toLowerCase(),
        };
      }
    }
  }
}

/** Match a native locator against the authorized workspace via its cwd directory. */
export async function grokBuildSourceWorkspaceMatch(
  locator: string,
  workspacePath: string,
): Promise<WorkspaceMatchKind | null> {
  const segments = locator.replace(/\\/g, '/').split('/');
  const encoded = segments.at(-3);
  if (!encoded) return null;
  const decoded = decodeGrokBuildWorkspaceDir(encoded);
  if (!decoded) return null;
  return matchSessionWorkspace(decoded, workspacePath);
}

export async function readGrokBuildNativeChatHistory(
  source: SelectedSource,
  limits?: Partial<ReaderLimits>,
): Promise<{ records: Array<{ record: NativeRecord; line: BoundedJsonRecord }>; incompleteTail: boolean }> {
  assertGrokBuildNativeEnabled();
  const sessionId = grokBuildNativeSessionId(source.locator);
  if (source.locatorClass !== GROK_BUILD_NATIVE_LOCATOR_CLASS || !sessionId) {
    throw new SessionContractError(
      'SOURCE_NOT_AUTHORIZED',
      'Grok Build native source must be an explicitly authorized chat_history.jsonl path',
    );
  }
  await authorizeSourceFile({
    selectedPath: source.locator,
    allowedRoots: source.authorizedScope.allowedRoots,
  });
  const input = await streamBoundedJsonLines({
    selectedPath: source.locator,
    allowedRoots: source.authorizedScope.allowedRoots,
  }, { consistency: 'provisional', limits });
  const records: Array<{ record: NativeRecord; line: BoundedJsonRecord }> = [];
  let lastSeq = -1;
  for await (const line of input) {
    const parsed = NativeRecordSchema.safeParse(line.value);
    if (!parsed.success) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        'unrecognized Grok Build native chat_history.jsonl record',
        schemaRejectionDetail(parsed.error),
      );
    }
    assertSupportedSchemaMajor(declaredSchema(parsed.data.schemaVersion), GROK_BUILD_NATIVE_SCHEMA_MAJOR);
    if (parsed.data.sessionId.toLowerCase() !== sessionId) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        'Grok Build native record session does not match its session directory',
        schemaIssueDetail('sessionId'),
      );
    }
    if (parsed.data.seq <= lastSeq) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        'Grok Build native chat history sequence is not strictly increasing',
        schemaIssueDetail('seq'),
      );
    }
    lastSeq = parsed.data.seq;
    if (parsed.data.role === 'tool' && !parsed.data.toolName) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        'Grok Build native tool record is missing its tool name',
        schemaIssueDetail('toolName'),
      );
    }
    records.push({ record: parsed.data, line });
  }
  if (records.length === 0) {
    throw new SessionContractError(
      'MALFORMED_SOURCE',
      'Grok Build native chat history is empty',
      schemaIssueDetail('<root>'),
    );
  }
  return { records, incompleteTail: input.incompleteTail };
}

export function toGrokBuildNativeRecord(
  sessionId: string,
  entry: { record: NativeRecord; line: BoundedJsonRecord },
): ProviderRecord {
  const { record, line } = entry;
  const occurredAt = timestamp(record.timestamp);
  const nativeEventId = record.id ?? `${sessionId}:${record.seq}`;
  const common = {
    lifecycle: 'unknown-at-import',
    provenance: {
      product: 'grok-build',
      acquisition: GROK_BUILD_NATIVE_LOCATOR_CLASS,
      sourceSchema: GROK_BUILD_NATIVE_SCHEMA_VERSION,
      nativeStoreInspected: true,
    },
    identity: { nativeSessionIdKnown: true, nativeEventIdKnown: true },
  };
  if (record.role === 'tool') {
    return {
      nativeSessionId: sessionId,
      nativeEventId,
      sequence: line.sequence * 1_000,
      kind: 'tool-call',
      role: 'tool',
      toolName: record.toolName,
      toolCallId: record.toolCallId,
      occurredAt,
      text: record.content,
      rawReference: { locatorClass: GROK_BUILD_NATIVE_LOCATOR_CLASS, sequence: line.sequence },
      extensions: common,
    };
  }
  return {
    nativeSessionId: sessionId,
    nativeEventId,
    sequence: line.sequence * 1_000,
    kind: 'message',
    role: record.role,
    occurredAt,
    text: record.content,
    rawReference: { locatorClass: GROK_BUILD_NATIVE_LOCATOR_CLASS, sequence: line.sequence },
    extensions: common,
  };
}

/** Read and validate active_sessions.json (read-only, bounded); throws on misuse. */
export async function readGrokBuildActiveRegistry(
  selectedPath: string,
  allowedRoots: string[],
): Promise<GrokBuildActiveRegistry> {
  assertGrokBuildNativeEnabled();
  const authorized = await authorizeSourceFile({
    selectedPath, allowedRoots, maxBytes: ACTIVE_SESSIONS_MAX_BYTES,
  });
  const raw = await readFile(authorized.canonicalPath, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SessionContractError(
      'SCHEMA_DRIFT',
      'Grok Build active_sessions.json is not valid JSON',
      schemaIssueDetail('<root>'),
    );
  }
  const parsed = ActiveSessionsSchema.safeParse(value);
  if (!parsed.success) {
    throw new SessionContractError(
      'SCHEMA_DRIFT',
      'unrecognized Grok Build active_sessions.json shape',
      schemaRejectionDetail(parsed.error),
    );
  }
  assertSupportedSchemaMajor(
    declaredSchema(parsed.data.schemaVersion), GROK_BUILD_ACTIVE_SESSIONS_SCHEMA_VERSION,
  );
  return parsed.data;
}

/** Provider-reported activity only; never a verified running process. */
export function grokBuildLiveState(
  registry: GrokBuildActiveRegistry | null,
  sessionId: string,
  nowMs = Date.now(),
): GrokBuildLiveEvidence {
  if (!registry) return { state: 'unknown', basis: 'none', reasonCode: 'NO_ACTIVE_SESSIONS_GRANT' };
  const entry = registry.sessions.find((item) => item.sessionId.toLowerCase() === sessionId.toLowerCase());
  if (!entry) return { state: 'unknown', basis: 'grok-active-sessions', reasonCode: 'SESSION_NOT_LISTED' };
  if (entry.lastHeartbeatAt === undefined) {
    return { state: 'unknown', basis: 'grok-active-sessions', reasonCode: 'NO_HEARTBEAT' };
  }
  const heartbeatMs = entry.lastHeartbeatAt < 10_000_000_000
    ? entry.lastHeartbeatAt * 1_000
    : entry.lastHeartbeatAt;
  if (!Number.isFinite(heartbeatMs)) {
    return { state: 'unknown', basis: 'grok-active-sessions', reasonCode: 'INVALID_HEARTBEAT' };
  }
  if (heartbeatMs > nowMs) {
    return { state: 'unknown', basis: 'grok-active-sessions', reasonCode: 'FUTURE_HEARTBEAT' };
  }
  if (nowMs - heartbeatMs > GROK_BUILD_ACTIVE_FRESHNESS_MS) {
    return { state: 'unknown', basis: 'grok-active-sessions', reasonCode: 'STALE_HEARTBEAT' };
  }
  return { state: 'active', basis: 'grok-active-sessions', reasonCode: 'FRESH_HEARTBEAT' };
}

export function parseGrokBuildNativeCursor(value?: string): number {
  if (!value) return 0;
  if (!/^\d+$/.test(value)) {
    throw new SessionContractError('SCHEMA_DRIFT', 'invalid Grok Build native cursor', schemaIssueDetail('cursor'));
  }
  return Number(value);
}

function declaredSchema(value: unknown): string {
  if (typeof value === 'number') return `${value}.0.0`;
  return /^\d+$/.test(String(value)) ? `${value}.0.0` : String(value);
}

function timestamp(value?: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const date = new Date(value < 10_000_000_000 ? value * 1_000 : value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
