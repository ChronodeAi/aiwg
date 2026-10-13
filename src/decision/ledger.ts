/**
 * Decision ask ledger — append-only call record for `aiwg decision ask`.
 *
 * Extends the existing decision CLI surface (#2946) rather than adding a new
 * subsystem: the ledger is one JSON-lines file under the project AIWG
 * artifact root (`.aiwg/decision/ledger.jsonl`, resolved the same way as
 * `aiwg artifacts path`).
 *
 * Writing the ledger is intentionally decoupled from `askDecision()` itself
 * (`./ask.js`): `recordDecisionAsk` is a small wrapper the CLI `ask` handler
 * and the MCP `decision-ask` tool both call after they already have a
 * `DecisionAskResult`, tagged with their transport. This keeps `askDecision`
 * free of I/O and keeps internal reuse (e.g. `setupJev`'s `--verify` probe)
 * out of the ledger: only completed `ask` calls — `answered` or `fallback` —
 * are recorded. CLI/MCP usage errors (bad flags, oversized context) never
 * reach a `DecisionAskResult` and are never recorded.
 *
 * Trust boundary (review r1/r2 #2946): this file defends against an
 * ACCIDENTAL hazard — a stray symlink, a hard link, loose permissions left
 * by another tool, a previous crash's partial write — all under the
 * assumption that the artifact root is owned and written by the SAME local
 * user running `aiwg`. It does not and cannot defend against a HOSTILE
 * process running as that same user: such a process already has read/write
 * access to everything the ledger could protect. There is no cross-process
 * lock and no privilege boundary here, by design — adding one would be the
 * "second subsystem" this feature deliberately avoids. Every filesystem
 * check below uses only portable Node primitives (no `/proc`, no handle
 * anchoring): `mkdir`/`lstat` for the directory, `open`+`fstat` for the
 * file, with `O_NOFOLLOW` applied when the platform defines it (POSIX; not
 * Windows). On a POSIX platform a small TOCTOU window exists between the
 * directory `lstat` and the file `open`; on Windows the symlink check is a
 * plain `lstat` pre-check with no kernel-enforced equivalent to
 * `O_NOFOLLOW`. Both are accepted given the trust boundary above. An
 * existing file or directory that fails a safety check is never modified —
 * recording is skipped and reported once via `warn`, never "fixed" by
 * chmod or truncation.
 *
 * Record size is capped at a level that stays below the conservative
 * single-write atomicity boundary most platforms also honor for `PIPE_BUF`
 * (4096 bytes on Linux): this makes a single, non-interleaved write the
 * overwhelmingly likely outcome for one record, but it is not a guarantee.
 * There is no cross-process append lock, so two concurrent writers can in
 * rare cases interleave and produce one malformed line; `history`/`stats`
 * detect and skip a malformed line (counted, never silently merged into a
 * neighboring record) rather than assuming it is impossible.
 *
 * Recording — attribution resolution and the write — is bounded by a short
 * deadline (`DECISION_LEDGER_RECORD_TIMEOUT_MS`). On timeout, the in-flight
 * attempt is not cancelled (Node has no way to abort an in-flight `open`),
 * so its outcome is genuinely unknown: the record may or may not eventually
 * land. The warning says exactly that ("completion unknown"), and no
 * further stage of that same attempt starts once the deadline has fired
 * (checked before each later `await`), so a slow attribution lookup cannot
 * itself delay the subsequent write past the deadline.
 */

import { randomUUID, createHash } from 'node:crypto';
import { constants as fsConstants, createReadStream, existsSync } from 'node:fs';
import { lstat, mkdir, open, type FileHandle } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { projectAiwgPath, projectAiwgWritePath } from '../config/project-artifacts.js';
import { redactText } from '../governance/redaction.js';
import { CanonicalJsonByteEstimator } from './context-plan.js';
import { resolveActiveProvider, type ProviderResolution } from '../cli/provider-resolution.js';
import type { DecisionAskInput, DecisionAskResult } from './ask.js';

export const DECISION_LEDGER_SCHEMA = 'aiwg-decision-ledger-record/v1';
const DECISION_LEDGER_DIR_NAME = 'decision';
const DECISION_LEDGER_FILE_NAME = 'ledger.jsonl';

export type DecisionLedgerTransport = 'cli' | 'mcp';
export type DecisionLedgerKind = 'yes-no' | 'choices' | 'scale';
const DECISION_LEDGER_KINDS: readonly DecisionLedgerKind[] = ['yes-no', 'choices', 'scale'];
const DECISION_LEDGER_STATUSES: readonly DecisionAskResult['status'][] = ['answered', 'fallback'];

export interface DecisionLedgerRecord {
  schema: typeof DECISION_LEDGER_SCHEMA;
  id: string;
  timestamp: string;
  transport: DecisionLedgerTransport;
  provider: string;
  sessionId: string;
  projectRoot: string;
  decisionKind: DecisionLedgerKind;
  choiceIds: string[] | null;
  /** Index of the selected option within the caller's full (un-truncated) choice/scale list, or null (yes-no, or no match). */
  answerIndex: number | null;
  /** Total choice/scale option count before the MAX_RECORDED_CHOICE_IDS cap; null for yes-no. */
  choiceCount: number | null;
  /** True when `choiceIds` is a truncated prefix of the full list (choiceCount > MAX_RECORDED_CHOICE_IDS). */
  choiceIdsTruncated: boolean;
  questionDigest: string;
  contextDigest: string | null;
  questionText?: string;
  contextText?: string;
  /** Present (and true) only when `--record-text` truncated a text field to fit the record-size cap. */
  textTruncated?: boolean;
  status: DecisionAskResult['status'];
  answer: DecisionAskResult['answer'];
  confidence: DecisionAskResult['confidence'];
  threshold: number;
  fallbackReason: string | null;
  model: DecisionAskResult['model'];
  usage: DecisionAskResult['usage'];
  latencyMs: number;
  estimatedLlmTokensAvoided: number;
  estimationMethod: string;
  caller: string | null;
}

/**
 * Per-decision-kind reasoning/output token allowance folded into the
 * "tokens avoided" estimate for answered calls. Named and recorded with
 * every estimate (not just referenced) so the figure can be recomputed
 * later per the issue's proposal item 3.
 */
export const DECISION_SAVINGS_REASONING_ALLOWANCE_TOKENS: Readonly<Record<DecisionLedgerKind, number>> = {
  'yes-no': 50,
  choices: 120,
  scale: 80,
};

export const DECISION_SAVINGS_ESTIMATION_METHOD =
  'aiwg-decision-savings/v1: answered = d06-canonical-json-utf8-ceil(question+context) + per-kind reasoning allowance; '
  + 'fallback = -(jev usage.inputTokens + usage.outputTokens), 0 when no Jev call was attempted (e.g. not-configured)';

// ---------------------------------------------------------------------------
// Attribution identifiers — `--caller`/`--session` use a conservative
// identifier shape that still covers documented forms like
// `address-issues:worker-pick` (colon-separated namespacing) and
// `flow/step@host` (review r2 finding 11). The CLI rejects a value outside
// this shape with exit 2; the MCP tool drops it to `null` instead (there is
// no CLI exit code to report through MCP). Either way the value is also
// redacted before being persisted — the shape restricts delimiters, not
// content.
// ---------------------------------------------------------------------------

export const MAX_ATTRIBUTION_FIELD_LENGTH = 96;
export const ATTRIBUTION_FIELD_PATTERN = /^[A-Za-z0-9_.:/@-]{1,96}$/;

// ---------------------------------------------------------------------------
// Record-size and metadata-field caps. Every persisted string is redacted
// (never just the two opt-in text fields) and capped, so neither a
// secret-shaped attribution tag nor a long path/choice list can grow a
// record past the atomicity-safe size ceiling below.
// ---------------------------------------------------------------------------

/** Post-redaction cap for provider/sessionId/projectRoot/caller/model/answer-as-string. */
const MAX_METADATA_FIELD_BYTES = 256;
/** The ledger records at most this many choice ids, regardless of how many the `ask` call itself allowed (up to 255); see `choiceCount`/`choiceIdsTruncated`. */
export const MAX_RECORDED_CHOICE_IDS = 10;
/** Post-redaction cap per recorded choice id. */
const MAX_CHOICE_ID_BYTES = 80;
/** Post-redaction, post-truncation cap per opt-in text field (`--record-text`). */
export const MAX_RECORD_TEXT_BYTES = 600;
/**
 * Hard cap on one serialized record line. Kept below 4096 (`PIPE_BUF` on
 * Linux) as a conservative single-write-atomicity margin — see the module
 * doc comment. Not a guarantee: see the module doc comment on concurrent
 * writers.
 */
export const MAX_LEDGER_RECORD_BYTES = 4000;

/** Bounds how long `recordDecisionAsk` waits on attribution resolution and the write. On timeout the outcome is reported as unknown, not "abandoned" — see the module doc comment. */
export const DECISION_LEDGER_RECORD_TIMEOUT_MS = 250;

const LEDGER_DIR_MODE = 0o700;
const LEDGER_FILE_MODE = 0o600;
const IS_WINDOWS = process.platform === 'win32';
const HAS_O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === 'number';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1; // back out of a multi-byte UTF-8 sequence
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

/** Redact, then cap to `maxBytes`. Applied to EVERY persisted string field, not only opt-in text. */
function sanitizeField(value: string | null | undefined, maxBytes = MAX_METADATA_FIELD_BYTES): string | null {
  if (value === null || value === undefined) return null;
  const redacted = redactText(value, { limits: { maxInputBytes: 64 * 1024 } }).text;
  return truncateUtf8(redacted, maxBytes).text;
}

/** A choice is `id` or `id=description`; only the id is recorded (see parseChoice in ./ask.ts). */
function choiceId(entry: string): string {
  const separator = entry.indexOf('=');
  return (separator < 0 ? entry : entry.slice(0, separator)).trim();
}

function fullChoiceIds(mode: DecisionAskInput['mode']): string[] | null {
  if (mode.kind === 'yes-no') return null;
  return mode.kind === 'choices'
    ? mode.choices.map(choiceId)
    : Array.from({ length: mode.high - mode.low + 1 }, (_, index) => String(mode.low + index));
}

function choiceCountFor(mode: DecisionAskInput['mode']): number | null {
  const ids = fullChoiceIds(mode);
  return ids === null ? null : ids.length;
}

/** Index of the selected answer in the caller's full choice/scale list — identity that survives redaction (review r2 finding 7). */
function answerIndexFor(mode: DecisionAskInput['mode'], rawAnswer: DecisionAskResult['answer']): number | null {
  if (mode.kind === 'yes-no') return null;
  if (mode.kind === 'choices') {
    if (typeof rawAnswer !== 'string') return null;
    const index = mode.choices.map(choiceId).indexOf(rawAnswer);
    return index < 0 ? null : index;
  }
  if (typeof rawAnswer !== 'number' || !Number.isInteger(rawAnswer) || rawAnswer < mode.low || rawAnswer > mode.high) return null;
  return rawAnswer - mode.low;
}

/** Mirrors ask.ts's private contextMessage(): what is actually sent to Jev as input. */
function contextMessageForEstimate(input: DecisionAskInput): string {
  return input.context === undefined || input.context === '' ? input.question : `${input.question}\n\nContext:\n${input.context}`;
}

function estimateSavings(input: DecisionAskInput, result: DecisionAskResult): { estimatedLlmTokensAvoided: number; estimationMethod: string } {
  if (result.status === 'answered') {
    const inputTokens = new CanonicalJsonByteEstimator().estimate(contextMessageForEstimate(input)).tokens;
    const allowance = DECISION_SAVINGS_REASONING_ALLOWANCE_TOKENS[input.mode.kind];
    return { estimatedLlmTokensAvoided: inputTokens + allowance, estimationMethod: DECISION_SAVINGS_ESTIMATION_METHOD };
  }
  const jevCost = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
  // Avoid signed zero (`-0`): a fallback that never called Jev (e.g. not-configured) costs nothing.
  return { estimatedLlmTokensAvoided: jevCost === 0 ? 0 : -jevCost, estimationMethod: DECISION_SAVINGS_ESTIMATION_METHOD };
}

/**
 * `--session`, then `AIWG_SESSION_ID`, else the literal "unknown" (no
 * harness-specific session env helper exists in this repo yet). Either
 * source is rejected down to "unknown" if it does not match the
 * attribution identifier shape — this is the safety net for the
 * environment-derived value, which (unlike `--session`) has no CLI exit
 * code to reject through.
 */
export function resolveDecisionSessionId(explicitSessionId: string | undefined, env: NodeJS.ProcessEnv): string {
  const explicit = explicitSessionId?.trim();
  if (explicit && ATTRIBUTION_FIELD_PATTERN.test(explicit)) return explicit;
  const fromEnv = env.AIWG_SESSION_ID?.trim();
  if (fromEnv && ATTRIBUTION_FIELD_PATTERN.test(fromEnv)) return fromEnv;
  return 'unknown';
}

export interface DecisionLedgerBuildContext {
  transport: DecisionLedgerTransport;
  provider: string;
  sessionId: string;
  /** Project root; stored (redacted) as the record's own `projectRoot` field. */
  projectRoot: string;
  caller?: string | null;
  /** Opt-in: include redacted, length-capped question/context text. Never on by default. */
  recordText?: boolean;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable id generator for tests. */
  id?: () => string;
}

function withinRecordBudget(record: DecisionLedgerRecord): boolean {
  return Buffer.byteLength(JSON.stringify(record), 'utf8') <= MAX_LEDGER_RECORD_BYTES;
}

/** Drops optional text fields (context first, then question) until the record fits the hard size cap. */
function enforceRecordBudget(record: DecisionLedgerRecord): DecisionLedgerRecord {
  if (withinRecordBudget(record)) return record;
  if (record.contextText !== undefined) {
    const { contextText, ...rest } = record;
    record = { ...(rest as DecisionLedgerRecord), textTruncated: true };
    if (withinRecordBudget(record)) return record;
  }
  if (record.questionText !== undefined) {
    const { questionText, ...rest } = record;
    record = { ...(rest as DecisionLedgerRecord), textTruncated: true };
  }
  return record;
}

/** Pure, synchronous and side-effect free: builds the record this call would append, fully sanitized. */
export function buildDecisionLedgerRecord(
  input: DecisionAskInput,
  result: DecisionAskResult,
  context: DecisionLedgerBuildContext,
): DecisionLedgerRecord {
  const timestamp = new Date((context.now ?? Date.now)()).toISOString();
  const { estimatedLlmTokensAvoided, estimationMethod } = estimateSavings(input, result);
  const caller = context.caller && ATTRIBUTION_FIELD_PATTERN.test(context.caller) ? context.caller : null;
  const rawAnswer = result.answer;
  const answer = typeof rawAnswer === 'string' ? sanitizeField(rawAnswer) : rawAnswer;
  const fullIds = fullChoiceIds(input.mode);
  const choiceCount = choiceCountFor(input.mode);
  const choiceIdsTruncated = choiceCount !== null && choiceCount > MAX_RECORDED_CHOICE_IDS;
  const choiceIds = fullIds === null ? null : fullIds.slice(0, MAX_RECORDED_CHOICE_IDS).map(id => sanitizeField(id, MAX_CHOICE_ID_BYTES) ?? '');
  let record: DecisionLedgerRecord = {
    schema: DECISION_LEDGER_SCHEMA,
    id: (context.id ?? randomUUID)(),
    timestamp,
    transport: context.transport,
    provider: sanitizeField(context.provider) ?? 'unknown',
    sessionId: sanitizeField(context.sessionId) ?? 'unknown',
    projectRoot: sanitizeField(context.projectRoot) ?? '',
    decisionKind: input.mode.kind,
    choiceIds,
    answerIndex: answerIndexFor(input.mode, rawAnswer),
    choiceCount,
    choiceIdsTruncated,
    questionDigest: sha256Hex(input.question),
    contextDigest: input.context === undefined ? null : sha256Hex(input.context),
    status: result.status,
    answer,
    confidence: result.confidence,
    threshold: input.threshold ?? 0.8,
    fallbackReason: result.status === 'fallback' ? result.reason : null,
    model: typeof result.model === 'string' ? sanitizeField(result.model) : result.model,
    usage: result.usage,
    latencyMs: result.latencyMs,
    estimatedLlmTokensAvoided,
    estimationMethod,
    caller: sanitizeField(caller, MAX_METADATA_FIELD_BYTES),
  };
  if (context.recordText) {
    const question = truncateUtf8(redactText(input.question).text, MAX_RECORD_TEXT_BYTES);
    record = { ...record, questionText: question.text, textTruncated: question.truncated };
    if (input.context !== undefined) {
      const contextField = truncateUtf8(redactText(input.context).text, MAX_RECORD_TEXT_BYTES);
      record = { ...record, contextText: contextField.text, textTruncated: record.textTruncated || contextField.truncated };
    }
  }
  return enforceRecordBudget(record);
}

function ledgerReadPath(projectRoot: string): string {
  return projectAiwgPath(projectRoot, DECISION_LEDGER_DIR_NAME, DECISION_LEDGER_FILE_NAME);
}

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** At most one warning per call; the emitter itself never throws. */
function makeOnceWarn(custom: ((message: string) => void) | undefined): (message: string) => void {
  let warned = false;
  return (message: string) => {
    if (warned) return;
    warned = true;
    try {
      (custom ?? defaultWarn)(message);
    } catch {
      // Warning emission must never escape — a throwing warn callback must not change the result.
    }
  };
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/**
 * Create (if needed) the owner-only `decision` directory and verify it is
 * safe to use: a real directory (not a symlink), and on POSIX owned by the
 * current user. An existing directory that fails either check is never
 * modified (no chmod) — recording is skipped.
 */
async function ensurePrivateDecisionDir(projectRoot: string, warn: (message: string) => void): Promise<string | null> {
  const artifactRoot = projectAiwgWritePath(projectRoot);
  const decisionDir = join(artifactRoot, DECISION_LEDGER_DIR_NAME);
  try {
    await mkdir(decisionDir, { recursive: true, mode: LEDGER_DIR_MODE });
  } catch (error) {
    warn(`warning: cannot create decision ledger directory: ${errorMessage(error)}`);
    return null;
  }
  let stat;
  try {
    stat = await lstat(decisionDir);
  } catch (error) {
    warn(`warning: cannot stat decision ledger directory: ${errorMessage(error)}`);
    return null;
  }
  if (!stat.isDirectory()) {
    warn('warning: decision ledger directory is not a real directory (possibly a symlink); skipping record');
    return null;
  }
  if (!IS_WINDOWS) {
    const uid = currentUid();
    if (uid !== null && stat.uid !== uid) {
      warn('warning: decision ledger directory is not owned by the current user; skipping record');
      return null;
    }
  }
  return decisionDir;
}

/**
 * Open (creating if needed) `ledger.jsonl` for append and verify it is safe
 * to write: a regular file with exactly one hard link (rejects a
 * pre-planted hard link to an unrelated file, which `O_NOFOLLOW` alone does
 * not catch), and on POSIX owned by the current user with no group/other
 * permission bits. `O_NOFOLLOW` is applied when the platform defines it
 * (refusing a pre-planted symlink at open time on POSIX); on platforms
 * without it (Windows) a prior plain `lstat` is the only symlink check —
 * see the module doc comment on the trust boundary. A file that fails any
 * check is closed untouched (no chmod, no write) and recording is skipped
 * with exactly one warning naming the reason.
 */
async function openLedgerFileForAppend(ledgerPath: string, warn: (message: string) => void): Promise<FileHandle | null> {
  try {
    const pre = await lstat(ledgerPath);
    if (pre.isSymbolicLink()) {
      warn('warning: decision ledger file is a symlink; skipping record');
      return null;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`warning: cannot stat decision ledger file: ${errorMessage(error)}`);
      return null;
    }
  }
  const flags = fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | (HAS_O_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
  let handle: FileHandle;
  try {
    handle = await open(ledgerPath, flags, LEDGER_FILE_MODE);
  } catch (error) {
    warn(`warning: cannot open decision ledger file: ${errorMessage(error)}`);
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      warn('warning: decision ledger path is not a regular file; skipping record');
      await handle.close();
      return null;
    }
    if (stat.nlink !== 1) {
      warn('warning: decision ledger file has more than one hard link; skipping record');
      await handle.close();
      return null;
    }
    if (!IS_WINDOWS) {
      const uid = currentUid();
      if (uid !== null && stat.uid !== uid) {
        warn('warning: decision ledger file is not owned by the current user; skipping record');
        await handle.close();
        return null;
      }
      if ((stat.mode & 0o077) !== 0) {
        warn('warning: decision ledger file has group or other permission bits set; skipping record');
        await handle.close();
        return null;
      }
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    warn(`warning: cannot verify decision ledger file safety: ${errorMessage(error)}`);
    return null;
  }
}

/** True when the ledger's last byte is not `\n` (so a prior partial/crashed write cannot absorb the next record). Read through a separate read-only handle; best-effort — any failure here means "do not prepend", never a hard error. */
async function needsLeadingNewline(ledgerPath: string): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(ledgerPath, fsConstants.O_RDONLY | (HAS_O_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0));
    const stat = await handle.stat();
    if (stat.size === 0) return false;
    const buffer = Buffer.alloc(1);
    const { bytesRead } = await handle.read({ buffer, position: stat.size - 1, length: 1 });
    return bytesRead !== 1 || buffer[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export type LedgerWriteChunk = (handle: FileHandle, buffer: Buffer) => Promise<number>;

async function defaultWriteChunk(handle: FileHandle, buffer: Buffer): Promise<number> {
  const { bytesWritten } = await handle.write(buffer);
  return bytesWritten;
}

/** Writes every byte of `buffer`, looping on a short write rather than assuming one `write()` call finishes the job. */
async function writeFully(handle: FileHandle, buffer: Buffer, writeChunk: LedgerWriteChunk = defaultWriteChunk): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const written = await writeChunk(handle, buffer.subarray(offset));
    if (!Number.isFinite(written) || written <= 0) throw new Error('decision ledger: write made no progress (short write)');
    offset += written;
  }
}

export interface AppendDecisionLedgerOptions {
  projectRoot: string;
  warn?: (message: string) => void;
  /** Test-only: override the low-level write primitive to simulate short writes. */
  writeChunk?: LedgerWriteChunk;
}

/**
 * Best-effort append. A failure here must never change the decision result
 * or exit code — every failure is caught and reported through `warn` (at
 * most once; see `makeOnceWarn`), never thrown. Returns `true` once the
 * record is durably appended, `false` on a handled (warned) failure.
 */
export async function appendDecisionLedgerRecord(record: DecisionLedgerRecord, options: AppendDecisionLedgerOptions): Promise<boolean> {
  const warn = makeOnceWarn(options.warn);
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_LEDGER_RECORD_BYTES) {
    warn(`warning: decision ledger record exceeds the ${MAX_LEDGER_RECORD_BYTES}-byte size cap and was not written`);
    return false;
  }
  const decisionDir = await ensurePrivateDecisionDir(options.projectRoot, warn);
  if (!decisionDir) return false;
  const ledgerPath = join(decisionDir, DECISION_LEDGER_FILE_NAME);
  const handle = await openLedgerFileForAppend(ledgerPath, warn);
  if (!handle) return false;
  try {
    const prefix = (await needsLeadingNewline(ledgerPath)) ? '\n' : '';
    await writeFully(handle, Buffer.from(prefix + line, 'utf8'), options.writeChunk);
    return true;
  } catch (error) {
    warn(`warning: failed to append decision ledger record: ${errorMessage(error)}`);
    return false;
  } finally {
    await handle.close().catch(() => {});
  }
}

export interface RecordDecisionAskOptions {
  transport: DecisionLedgerTransport;
  /** Project root; used both to resolve the ledger location and to resolve the active provider. */
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  /** `--provider` override. */
  explicitProvider?: string;
  /** `--session` override (CLI only; MCP relies on `AIWG_SESSION_ID`). */
  explicitSessionId?: string;
  /** Pre-validated attribution tag; an invalid shape is coerced to `null` defensively. */
  caller?: string | null;
  recordText?: boolean;
  now?: () => number;
  id?: () => string;
  warn?: (message: string) => void;
  /** Overrides `DECISION_LEDGER_RECORD_TIMEOUT_MS`; test-only. */
  timeoutMs?: number;
  /** Test injection point for provider resolution; defaults to `resolveActiveProvider`. */
  resolveProvider?: (options: { cwd: string; explicitProvider?: string; env?: NodeJS.ProcessEnv }) => Promise<ProviderResolution>;
  /** Test-only: forwarded to `appendDecisionLedgerRecord` to simulate short writes. */
  writeChunk?: LedgerWriteChunk;
}

/** Never throws: a provider-detection failure (missing config, unreadable capability matrix, …) degrades to "unknown". */
async function resolveProviderSafely(options: RecordDecisionAskOptions): Promise<string> {
  try {
    const resolve = options.resolveProvider ?? resolveActiveProvider;
    const resolution = await resolve({ cwd: options.projectRoot, explicitProvider: options.explicitProvider, env: options.env ?? process.env });
    return resolution.provider ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

interface CancellationFlag {
  cancelled: boolean;
}

async function performRecord(
  input: DecisionAskInput,
  result: DecisionAskResult,
  options: RecordDecisionAskOptions,
  warn: (message: string) => void,
  flag: CancellationFlag,
): Promise<DecisionLedgerRecord | null> {
  try {
    const provider = await resolveProviderSafely(options);
    if (flag.cancelled) return null;
    const sessionId = resolveDecisionSessionId(options.explicitSessionId, options.env ?? process.env);
    const record = buildDecisionLedgerRecord(input, result, {
      transport: options.transport,
      provider,
      sessionId,
      projectRoot: options.projectRoot,
      caller: options.caller,
      recordText: options.recordText,
      now: options.now,
      id: options.id,
    });
    if (flag.cancelled) return null;
    const appended = await appendDecisionLedgerRecord(record, { projectRoot: options.projectRoot, warn, writeChunk: options.writeChunk });
    return appended ? record : null;
  } catch (error) {
    warn(`warning: failed to record decision ledger entry: ${errorMessage(error)}`);
    return null;
  }
}

const TIMED_OUT = Symbol('decision-ledger-record-timeout');

/**
 * Build and append exactly one ledger record for one `askDecision()` call.
 * Called by the CLI `ask` handler and the MCP `decision-ask` tool — the
 * "same function" referenced in the issue's MCP-parity requirement — each
 * tagging its own `transport`. Attribution resolution (provider/session) and
 * the write both happen inside this one bounded step: never throws, warns at
 * most once, and never waits longer than `timeoutMs` (default
 * `DECISION_LEDGER_RECORD_TIMEOUT_MS`) before returning `null` to the
 * caller. The in-flight attempt itself is not cancelled on timeout (Node
 * cannot abort an in-flight filesystem call); its own later stages simply
 * never start (checked via a cancellation flag before each one), and its
 * eventual settlement — successful or not — is swallowed rather than
 * reported. The caller's own decision result and exit code are therefore
 * always untouched, whether this returns the appended record or `null`.
 */
export async function recordDecisionAsk(
  input: DecisionAskInput,
  result: DecisionAskResult,
  options: RecordDecisionAskOptions,
): Promise<DecisionLedgerRecord | null> {
  const warn = makeOnceWarn(options.warn);
  const timeoutMs = options.timeoutMs ?? DECISION_LEDGER_RECORD_TIMEOUT_MS;
  const flag: CancellationFlag = { cancelled: false };
  const work = performRecord(input, result, options, warn, flag);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([work, timedOut]);
    if (outcome === TIMED_OUT) {
      flag.cancelled = true;
      warn(`warning: decision ledger recording exceeded ${timeoutMs}ms; completion unknown`);
      work.catch(() => {}); // let the background attempt settle without an unhandled rejection
      return null;
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Read-back: history and stats. Both stream the ledger line-by-line rather
// than loading and splitting the whole file, validate each record strictly
// (reporting a `skipped` count rather than trusting a malformed line), and
// aggregate incrementally (no array spread into Math.min/max).
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidCalendarComponents(year: number, month1: number, day: number, hour: number, minute: number, second: number): boolean {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return false;
  const date = new Date(Date.UTC(year, month1 - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month1 - 1 && date.getUTCDate() === day;
}

// Our own writer always emits exactly this shape via Date#toISOString().
const RECORD_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/;

/** Strict: the exact `toISOString()` shape, with calendar/time components validated (review r2 finding 10/12). */
function isStrictRecordTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = RECORD_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;
  const [, y, mo, d, h, mi, s] = match;
  return isValidCalendarComponents(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s));
}

function isUnitIntervalOrNull(value: unknown): boolean {
  return value === null || (isFiniteNumber(value) && value >= 0 && value <= 1);
}

function isNonNegativeOrNull(value: unknown): boolean {
  return value === null || (isFiniteNumber(value) && value >= 0);
}

function isUsageShape(value: unknown): value is DecisionAskResult['usage'] {
  if (value === null) return true;
  if (typeof value !== 'object') return false;
  const usage = value as Record<string, unknown>;
  return isNonNegativeOrNull(usage.inputTokens) && isNonNegativeOrNull(usage.outputTokens);
}

/** Validates required fields, enums, the timestamp and every numeric field (with meaningful ranges) before a record is trusted. */
function isDecisionLedgerRecord(value: unknown): value is DecisionLedgerRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.schema !== DECISION_LEDGER_SCHEMA) return false;
  if (typeof record.id !== 'string' || record.id.length === 0) return false;
  if (!isStrictRecordTimestamp(record.timestamp)) return false;
  if (record.transport !== 'cli' && record.transport !== 'mcp') return false;
  if (typeof record.provider !== 'string') return false;
  if (typeof record.sessionId !== 'string') return false;
  if (typeof record.projectRoot !== 'string') return false;
  if (!(DECISION_LEDGER_KINDS as readonly string[]).includes(record.decisionKind as string)) return false;
  if (record.choiceIds !== null && !(Array.isArray(record.choiceIds) && record.choiceIds.every(id => typeof id === 'string'))) return false;
  if (record.answerIndex !== null && !(Number.isInteger(record.answerIndex) && (record.answerIndex as number) >= 0)) return false;
  if (record.choiceCount !== null && !(Number.isInteger(record.choiceCount) && (record.choiceCount as number) >= 0)) return false;
  if (typeof record.choiceIdsTruncated !== 'boolean') return false;
  if (!/^[a-f0-9]{64}$/.test(record.questionDigest as string)) return false;
  if (record.contextDigest !== null && !/^[a-f0-9]{64}$/.test(record.contextDigest as string)) return false;
  if (!(DECISION_LEDGER_STATUSES as readonly string[]).includes(record.status as string)) return false;
  if (!['string', 'boolean', 'number'].includes(typeof record.answer) && record.answer !== null) return false;
  if (!isUnitIntervalOrNull(record.confidence)) return false;
  if (!isUnitIntervalOrNull(record.threshold) || record.threshold === null) return false;
  if (record.fallbackReason !== null && typeof record.fallbackReason !== 'string') return false;
  if (record.model !== null && typeof record.model !== 'string') return false;
  if (!isUsageShape(record.usage)) return false;
  if (!isNonNegativeOrNull(record.latencyMs) || record.latencyMs === null) return false;
  if (!isFiniteNumber(record.estimatedLlmTokensAvoided)) return false; // may be negative
  if (typeof record.estimationMethod !== 'string') return false;
  if (record.caller !== null && typeof record.caller !== 'string') return false;
  return true;
}

async function* streamDecisionLedgerLines(path: string): AsyncGenerator<string> {
  if (!existsSync(path)) return;
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
  }
}

/** Streams parsed-and-validated records one at a time; invalid lines yield `null` so callers can count them as skipped. */
async function* streamDecisionLedgerRecords(projectRoot: string): AsyncGenerator<DecisionLedgerRecord | null> {
  for await (const line of streamDecisionLedgerLines(ledgerReadPath(projectRoot))) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      yield isDecisionLedgerRecord(parsed) ? parsed : null;
    } catch {
      yield null;
    }
  }
}

export interface DecisionLedgerFilters {
  since?: Date;
  provider?: string;
  sessionId?: string;
  kind?: DecisionLedgerKind;
  status?: DecisionAskResult['status'];
}

function matchesFilters(record: DecisionLedgerRecord, filters: DecisionLedgerFilters): boolean {
  if (filters.since && new Date(record.timestamp).getTime() < filters.since.getTime()) return false;
  if (filters.provider !== undefined && record.provider !== filters.provider) return false;
  if (filters.sessionId !== undefined && record.sessionId !== filters.sessionId) return false;
  if (filters.kind !== undefined && record.decisionKind !== filters.kind) return false;
  if (filters.status !== undefined && record.status !== filters.status) return false;
  return true;
}

/** Exposed for direct unit testing; `decisionLedgerHistory`/`decisionLedgerStats` apply this per streamed record instead. */
export function filterDecisionLedgerRecords(records: readonly DecisionLedgerRecord[], filters: DecisionLedgerFilters): DecisionLedgerRecord[] {
  return records.filter(record => matchesFilters(record, filters));
}

export interface DecisionLedgerHistoryResult {
  schema: 'aiwg-decision-ledger-history/v1';
  count: number;
  /** Lines that failed JSON parsing or record validation and were excluded. */
  skipped: number;
  records: DecisionLedgerRecord[];
}

/** Reads, validates and filters the ledger offline, streaming line-by-line; no network, no Jev call. Tolerates a missing ledger file (empty result). */
export async function decisionLedgerHistory(projectRoot: string, filters: DecisionLedgerFilters = {}): Promise<DecisionLedgerHistoryResult> {
  const records: DecisionLedgerRecord[] = [];
  let skipped = 0;
  for await (const record of streamDecisionLedgerRecords(projectRoot)) {
    if (!record) { skipped += 1; continue; }
    if (matchesFilters(record, filters)) records.push(record);
  }
  records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { schema: 'aiwg-decision-ledger-history/v1', count: records.length, skipped, records };
}

export type DecisionLedgerGroupBy = 'provider' | 'session' | 'kind' | 'caller';

export interface DecisionLedgerStatsFilters extends DecisionLedgerFilters {
  groupBy?: DecisionLedgerGroupBy;
}

export interface DecisionLedgerStatsGroup {
  /** `null` only for the caller group when no record in the group carries a `--caller` tag — distinct from the literal string "unattributed". */
  key: string | null;
  totalCalls: number;
  answered: number;
  fallback: number;
  /** Fraction of this group's calls that fell back; denominator is `totalCalls`. */
  fallbackRate: number;
  /** Raw per-reason fallback counts. */
  fallbackCountByReason: Record<string, number>;
  /** Per-reason fallback counts as a fraction of `totalCalls` (same denominator as `fallbackRate`). */
  fallbackRateByReason: Record<string, number>;
  confidence: { count: number; mean: number | null; min: number | null; max: number | null };
  jevUsage: { inputTokens: number; outputTokens: number };
  estimatedLlmTokensAvoidedTotal: number;
  /**
   * `estimatedLlmTokensAvoidedTotal` minus the Jev usage actually spent on
   * ANSWERED calls only: each fallback record's own estimate already
   * subtracts that call's Jev usage, so re-subtracting all usage here would
   * double-count it.
   */
  netSavingsTokens: number;
}

export interface DecisionLedgerStatsResult {
  schema: 'aiwg-decision-ledger-stats/v1';
  groupBy: DecisionLedgerGroupBy | null;
  skipped: number;
  groups: DecisionLedgerStatsGroup[];
}

function groupKeyFor(record: DecisionLedgerRecord, groupBy: DecisionLedgerGroupBy | undefined): string | null {
  if (!groupBy) return 'all';
  if (groupBy === 'provider') return record.provider;
  if (groupBy === 'session') return record.sessionId;
  if (groupBy === 'kind') return record.decisionKind;
  return record.caller; // may be null; kept distinct from the literal string "unattributed"
}

interface StatsAccumulator {
  totalCalls: number;
  answered: number;
  fallback: number;
  fallbackCountByReason: Record<string, number>;
  confidenceCount: number;
  confidenceSum: number;
  confidenceMin: number | null;
  confidenceMax: number | null;
  jevInputTokens: number;
  jevOutputTokens: number;
  answeredJevInputTokens: number;
  answeredJevOutputTokens: number;
  estimatedLlmTokensAvoidedTotal: number;
}

function newAccumulator(): StatsAccumulator {
  return {
    totalCalls: 0, answered: 0, fallback: 0, fallbackCountByReason: {},
    confidenceCount: 0, confidenceSum: 0, confidenceMin: null, confidenceMax: null,
    jevInputTokens: 0, jevOutputTokens: 0, answeredJevInputTokens: 0, answeredJevOutputTokens: 0,
    estimatedLlmTokensAvoidedTotal: 0,
  };
}

function accumulate(acc: StatsAccumulator, record: DecisionLedgerRecord): void {
  acc.totalCalls += 1;
  const inputTokens = record.usage?.inputTokens ?? 0;
  const outputTokens = record.usage?.outputTokens ?? 0;
  if (record.status === 'answered') {
    acc.answered += 1;
    if (record.confidence !== null) {
      acc.confidenceCount += 1;
      acc.confidenceSum += record.confidence;
      acc.confidenceMin = acc.confidenceMin === null ? record.confidence : Math.min(acc.confidenceMin, record.confidence);
      acc.confidenceMax = acc.confidenceMax === null ? record.confidence : Math.max(acc.confidenceMax, record.confidence);
    }
    acc.answeredJevInputTokens += inputTokens;
    acc.answeredJevOutputTokens += outputTokens;
  } else {
    acc.fallback += 1;
    const reason = record.fallbackReason ?? 'unknown';
    acc.fallbackCountByReason[reason] = (acc.fallbackCountByReason[reason] ?? 0) + 1;
  }
  acc.jevInputTokens += inputTokens;
  acc.jevOutputTokens += outputTokens;
  acc.estimatedLlmTokensAvoidedTotal += record.estimatedLlmTokensAvoided;
}

function finalizeGroup(key: string | null, acc: StatsAccumulator): DecisionLedgerStatsGroup {
  const fallbackRateByReason: Record<string, number> = {};
  for (const [reason, count] of Object.entries(acc.fallbackCountByReason)) {
    fallbackRateByReason[reason] = acc.totalCalls ? count / acc.totalCalls : 0;
  }
  return {
    key,
    totalCalls: acc.totalCalls,
    answered: acc.answered,
    fallback: acc.fallback,
    fallbackRate: acc.totalCalls ? acc.fallback / acc.totalCalls : 0,
    fallbackCountByReason: acc.fallbackCountByReason,
    fallbackRateByReason,
    confidence: {
      count: acc.confidenceCount,
      mean: acc.confidenceCount ? acc.confidenceSum / acc.confidenceCount : null,
      min: acc.confidenceMin,
      max: acc.confidenceMax,
    },
    jevUsage: { inputTokens: acc.jevInputTokens, outputTokens: acc.jevOutputTokens },
    estimatedLlmTokensAvoidedTotal: acc.estimatedLlmTokensAvoidedTotal,
    netSavingsTokens: acc.estimatedLlmTokensAvoidedTotal - (acc.answeredJevInputTokens + acc.answeredJevOutputTokens),
  };
}

/** Reads, validates, filters and aggregates the ledger offline, streaming line-by-line with incremental min/max; no network, no Jev call. Tolerates a missing ledger file (empty result). */
export async function decisionLedgerStats(projectRoot: string, filters: DecisionLedgerStatsFilters = {}): Promise<DecisionLedgerStatsResult> {
  const groups = new Map<string | null, StatsAccumulator>();
  let skipped = 0;
  for await (const record of streamDecisionLedgerRecords(projectRoot)) {
    if (!record) { skipped += 1; continue; }
    if (!matchesFilters(record, filters)) continue;
    const key = groupKeyFor(record, filters.groupBy);
    let acc = groups.get(key);
    if (!acc) { acc = newAccumulator(); groups.set(key, acc); }
    accumulate(acc, record);
  }
  const sortedKeys = [...groups.keys()].sort((a, b) => (a ?? '').localeCompare(b ?? ''));
  return {
    schema: 'aiwg-decision-ledger-stats/v1',
    groupBy: filters.groupBy ?? null,
    skipped,
    groups: sortedKeys.map(key => finalizeGroup(key, groups.get(key) as StatsAccumulator)),
  };
}

// ---------------------------------------------------------------------------
// Since-date parsing — strict ISO-8601, offsetless timestamps and bare dates
// both interpreted as UTC, invalid calendar dates rejected (including when
// an explicit offset is present: the LOCAL calendar/time components are
// validated before the offset is applied).
// ---------------------------------------------------------------------------

export class DecisionLedgerSinceError extends Error {
  constructor(message: string) { super(message); this.name = 'DecisionLedgerSinceError'; }
}

const BARE_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Strict `--since` parser: bare `YYYY-MM-DD` and offsetless timestamps are UTC; invalid calendar dates are rejected regardless of whether an offset is present. */
export function parseDecisionLedgerSince(raw: string): Date {
  const bare = BARE_DATE_PATTERN.exec(raw);
  if (bare) {
    const [, y, mo, d] = bare.map(Number) as unknown as [number, number, number, number];
    if (!isValidCalendarComponents(y, mo, d, 0, 0, 0)) throw new DecisionLedgerSinceError(`--since is not a valid calendar date: ${raw}`);
    return new Date(Date.UTC(y, mo - 1, d));
  }
  const timestamp = TIMESTAMP_PATTERN.exec(raw);
  if (timestamp) {
    const [, y, mo, d, h, mi, s, frac, offset] = timestamp;
    // Validate the LOCAL calendar/time components as written, before any offset is applied —
    // an explicit offset must not let an impossible date (e.g. 2026-02-30) through.
    if (!isValidCalendarComponents(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s))) {
      throw new DecisionLedgerSinceError(`--since is not a valid calendar date: ${raw}`);
    }
    const normalized = `${y}-${mo}-${d}T${h}:${mi}:${s}${frac ?? ''}${offset ?? 'Z'}`;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) throw new DecisionLedgerSinceError(`--since is not a valid timestamp: ${raw}`);
    return date;
  }
  throw new DecisionLedgerSinceError(`--since must be an ISO-8601 date (YYYY-MM-DD) or timestamp: ${raw}`);
}
