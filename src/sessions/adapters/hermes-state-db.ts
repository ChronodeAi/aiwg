// Hermes state.db snapshot reader: read-only backup, schema-gated projection (synthetic physical schema v1).
import { chmod, lstat, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256, SessionContractError } from '../contracts.js';
import { requireFeaturePackage } from '../../features/runtime.js';
import { matchSessionWorkspace } from '../workspace-matching.js';
import type { ReaderLimits } from '../readers.js';

export const HERMES_STATE_DB_FILENAME = 'state.db';
export const HERMES_NATIVE_PHYSICAL_SCHEMA = 'hermes-synthetic-v1';
export const HERMES_SNAPSHOT_LOCATOR_CLASS = 'hermes-consistent-snapshot-jsonl';
const STAGING_DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
const MAX_SESSIONS = 1_000_000;

interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

interface SqliteDatabase {
  backup(destination: string): Promise<unknown>;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type SqliteModule = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => SqliteDatabase;

/** Owned staging beneath the workspace session store; never inside the provider tree. */
export function hermesSnapshotStagingDir(workspacePath: string): string {
  return join(resolve(workspacePath), '.aiwg', 'sessions', 'staging', 'hermes');
}

export function hermesSnapshotProjectionPath(stagingDir: string, canonicalRoot: string): string {
  return join(stagingDir, `state-${sha256(canonicalRoot).slice(7, 23)}.snapshot.jsonl`);
}

export interface HermesSnapshotResult {
  projectionPath: string;
  authorizedRoot: string;
  matched: number;
  excluded: number;
}

function loadSqlite(): SqliteModule {
  try {
    return requireFeaturePackage('better-sqlite3') as SqliteModule;
  } catch {
    throw new SessionContractError(
      'UNSUPPORTED_OPERATION',
      'Hermes native discovery requires the optional sqlite backend; '
        + 'run `aiwg features install sqlite`, then rediscover with --hermes-root.',
    );
  }
}

function sqliteUnavailable(error: unknown, what: string): SessionContractError {
  if (error instanceof SessionContractError) throw error;
  const code = typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'SQLITE_ERROR';
  return new SessionContractError(
    'UNSUPPORTED_OPERATION',
    `Hermes snapshot is unavailable while ${what} (sqlite ${code}); `
      + 'start Hermes so a consistent backup can be taken without writing to its directory, '
      + 'or import a `hermes sessions export` file instead.',
  );
}

/**
 * WAL reads need the provider's shared-memory index, and any first read
 * would create it as a provider-tree write. A WAL database without its
 * sidecars present therefore refuses BEFORE any SQLite contact — fail closed
 * rather than writing sidecars or reopening writable. (Hermes runs WAL mode;
 * the export fallback covers a stopped provider.) When the index pre-exists,
 * the read-only open reuses it without creating files; its volatile
 * read-marks may advance through normal WAL read concurrency — the same as
 * any Hermes reader — but tree membership, sizes, and database content never
 * change.
 */
async function assertReadableWithoutSidecarWrites(live: string): Promise<void> {
  const shm = await lstat(`${live}-shm`).then((item) => item.isFile()).catch(() => false);
  if (!shm) {
    throw new SessionContractError(
      'UNSUPPORTED_OPERATION',
      'Hermes snapshot needs the provider WAL sidecars (state.db-shm); '
        + 'start Hermes so a consistent backup can be taken without writing to its directory, '
        + 'or import a `hermes sessions export` file instead.',
    );
  }
}

async function authorizeLiveDb(liveDbPath: string, allowedRoots: string[]): Promise<string> {
  if (allowedRoots.length === 0) {
    throw new SessionContractError('SOURCE_NOT_AUTHORIZED', 'Hermes discovery requires --hermes-root.');
  }
  const selected = resolve(liveDbPath);
  const link = await lstat(selected).catch(() => null);
  if (!link) {
    throw new SessionContractError('SOURCE_NOT_AUTHORIZED', 'Hermes state.db is not available under --hermes-root.');
  }
  if (link.isSymbolicLink()) {
    throw new SessionContractError('SOURCE_SYMLINK', 'Hermes state.db cannot be a symlink.');
  }
  const canonical = await realpath(selected).catch(() => null);
  if (!canonical) {
    throw new SessionContractError('SOURCE_NOT_AUTHORIZED', 'Hermes state.db is not available under --hermes-root.');
  }
  const canonicalRoots = await Promise.all(allowedRoots.map(async (root) => resolve(root)));
  const inside = canonicalRoots.some((root) => canonical === root || canonical.startsWith(`${root}/`));
  if (!inside) {
    throw new SessionContractError('SOURCE_OUTSIDE_ALLOWED_ROOT', 'Hermes state.db escapes the authorized roots.');
  }
  const details = await stat(canonical);
  if (!details.isFile()) {
    throw new SessionContractError('SOURCE_NOT_REGULAR_FILE', 'Hermes state.db must be a regular file.');
  }
  if (details.size > MAX_SOURCE_BYTES) {
    throw new SessionContractError('RESOURCE_LIMIT_EXCEEDED', 'Hermes state.db exceeds the snapshot byte limit', {
      limit: 'maxBytes', configured: MAX_SOURCE_BYTES, observed: details.size,
    });
  }
  return canonical;
}

const REQUIRED_SESSION_COLUMNS = new Set([
  'id', 'source', 'user_id', 'model', 'model_config', 'parent_session_id',
  'compressed_from_session_id', 'started_at', 'ended_at', 'end_reason',
  'archived', 'inactive', 'cwd', 'git_branch', 'routing_key', 'input_tokens',
  'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens',
  'estimated_cost_usd', 'actual_cost_usd', 'billing_provider',
  'export_deleted_at', 'provider_deleted_at',
]);

const REQUIRED_MESSAGE_COLUMNS = new Set([
  'session_id', 'seq', 'id', 'role', 'content', 'tool_call_id', 'tool_calls',
  'tool_name', 'timestamp', 'token_count', 'finish_reason', 'reasoning',
  'reasoning_content', 'reasoning_details', 'codex_reasoning_items',
]);

function assertPhysicalSchema(backup: SqliteDatabase): void {
  const tables = new Set(backup.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all().map((row) => String(row.name)));
  if (!tables.has('meta') || !tables.has('sessions') || !tables.has('messages')) {
    throw new SessionContractError(
      'SCHEMA_DRIFT',
      'unrecognized Hermes state.db physical schema',
      { issues: [{ path: 'tables', code: 'custom' }] },
    );
  }
  const marker = backup.prepare('SELECT value FROM meta WHERE key = ?').get('native_schema');
  if (!marker || marker.value !== HERMES_NATIVE_PHYSICAL_SCHEMA) {
    throw new SessionContractError(
      'SCHEMA_DRIFT',
      'unsupported Hermes state.db physical schema version',
      { issues: [{ path: 'meta.native_schema', code: 'custom' }] },
    );
  }
  for (const [table, required] of [['sessions', REQUIRED_SESSION_COLUMNS], ['messages', REQUIRED_MESSAGE_COLUMNS]] as const) {
    const columns = new Set(backup.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
    for (const column of required) {
      if (!columns.has(column)) {
        throw new SessionContractError(
          'SCHEMA_DRIFT',
          `Hermes state.db table ${table} is missing column ${column}`,
          { issues: [{ path: `${table}.${column}`, code: 'custom' }] },
        );
      }
    }
  }
}

function parseJsonColumn(value: unknown, path: string): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new SessionContractError(
      'SCHEMA_DRIFT',
      `Hermes state.db column ${path} is not valid JSON`,
      { issues: [{ path, code: 'invalid_json' }] },
    );
  }
}

function optional<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

/**
 * Take a consistent backup of the live database (never opened for writing)
 * and project workspace-matching sessions to snapshot JSONL. Returns null
 * when no session matches the authorized workspace.
 */
export async function snapshotHermesStateDb(options: {
  hermesRoot: string;
  stagingDir: string;
  allowedRoots: string[];
  workspaceId: string;
  limits?: Partial<ReaderLimits>;
}): Promise<HermesSnapshotResult | null> {
  const canonicalRoot = await realpath(resolve(options.hermesRoot)).catch(() => resolve(options.hermesRoot));
  const live = await authorizeLiveDb(join(options.hermesRoot, HERMES_STATE_DB_FILENAME), options.allowedRoots);
  await assertReadableWithoutSidecarWrites(live);
  const Database = loadSqlite();
  await mkdir(options.stagingDir, { recursive: true, mode: STAGING_DIR_MODE });
  const staging = await realpath(options.stagingDir);
  const backupPath = join(staging, `.backup-${process.pid}-${Date.now()}.db`);
  const projectionPath = hermesSnapshotProjectionPath(staging, canonicalRoot);
  let source: SqliteDatabase | undefined;
  let backup: SqliteDatabase | undefined;
  try {
    source = new Database(live, { readonly: true, fileMustExist: true });
    await source.backup(backupPath);
  } catch (error) {
    throw sqliteUnavailable(error, 'opening the provider database for backup');
  } finally {
    source?.close();
  }
  try {
    backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    assertPhysicalSchema(backup);
    const sessions = backup.prepare(
      'SELECT * FROM sessions ORDER BY started_at ASC, id ASC',
    ).all();
    const lines: string[] = [];
    let matched = 0;
    let excluded = 0;
    let bytes = 0;
    for (const row of sessions) {
      if (matched + excluded >= MAX_SESSIONS) {
        throw new SessionContractError('RESOURCE_LIMIT_EXCEEDED', 'Hermes snapshot exceeds the session limit', {
          limit: 'maxSessions', configured: MAX_SESSIONS, observed: matched + excluded + 1,
        });
      }
      const cwd = typeof row.cwd === 'string' && row.cwd.length > 0 ? row.cwd : null;
      const workspaceMatch = cwd ? await matchSessionWorkspace(cwd, options.workspaceId) : null;
      if (!workspaceMatch) {
        excluded += 1;
        continue;
      }
      const messages = backup!.prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC',
      ).all(String(row.id));
      const record: Record<string, unknown> = {
        schemaVersion: 23,
        id: String(row.id),
        source: String(row.source ?? 'cli'),
        user_id: optional(row.user_id as string | null),
        model: optional(row.model as string | null),
        model_config: parseJsonColumn(row.model_config, 'sessions.model_config'),
        parent_session_id: optional(row.parent_session_id as string | null),
        compressed_from_session_id: optional(row.compressed_from_session_id as string | null),
        started_at: row.started_at,
        ended_at: optional(row.ended_at as number | null),
        end_reason: optional(row.end_reason as string | null),
        archived: row.archived,
        inactive: row.inactive,
        cwd,
        git_branch: optional(row.git_branch as string | null),
        routing_key: optional(row.routing_key as string | null),
        input_tokens: optional(row.input_tokens as number | null),
        output_tokens: optional(row.output_tokens as number | null),
        cache_read_tokens: optional(row.cache_read_tokens as number | null),
        cache_write_tokens: optional(row.cache_write_tokens as number | null),
        reasoning_tokens: optional(row.reasoning_tokens as number | null),
        estimated_cost_usd: optional(row.estimated_cost_usd as number | null),
        actual_cost_usd: optional(row.actual_cost_usd as number | null),
        billing_provider: optional(row.billing_provider as string | null),
        messages: messages.map((message) => ({
          id: message.id,
          role: String(message.role),
          content: parseJsonColumn(message.content, 'messages.content'),
          tool_call_id: optional(message.tool_call_id as string | null),
          tool_calls: parseJsonColumn(message.tool_calls, 'messages.tool_calls'),
          tool_name: optional(message.tool_name as string | null),
          timestamp: optional(message.timestamp as number | null),
          token_count: optional(message.token_count as number | null),
          finish_reason: optional(message.finish_reason as string | null),
          reasoning: optional(message.reasoning as string | null),
          reasoning_content: optional(message.reasoning_content as string | null),
          reasoning_details: parseJsonColumn(message.reasoning_details, 'messages.reasoning_details'),
          codex_reasoning_items: parseJsonColumn(message.codex_reasoning_items, 'messages.codex_reasoning_items'),
        })),
        export_deleted_at: optional(row.export_deleted_at as number | null),
        provider_deleted_at: optional(row.provider_deleted_at as number | null),
        snapshotConsistency: 'sqlite-backup',
      };
      const line = `${JSON.stringify(record)}\n`;
      bytes += Buffer.byteLength(line);
      if (bytes > MAX_SOURCE_BYTES) {
        throw new SessionContractError('RESOURCE_LIMIT_EXCEEDED', 'Hermes snapshot exceeds the projection byte limit', {
          limit: 'maxBytes', configured: MAX_SOURCE_BYTES, observed: bytes,
        });
      }
      lines.push(line);
      matched += 1;
    }
    if (matched === 0) return null;
    await writeFile(projectionPath, lines.join(''), { mode: FILE_MODE });
    await chmod(projectionPath, FILE_MODE);
    return { projectionPath, authorizedRoot: staging, matched, excluded };
  } catch (error) {
    throw sqliteUnavailable(error, 'reading the snapshot');
  } finally {
    backup?.close();
    await rm(backupPath, { force: true });
  }
}
