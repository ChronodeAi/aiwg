import { lstat, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { SessionContractError, type SessionEvent } from './contracts.js';

export interface SourceAuthorization {
  selectedPath: string;
  allowedRoots: string[];
  allowSymlink?: boolean;
  maxBytes?: number;
}

export interface AuthorizedFile {
  canonicalPath: string;
  rootClass: string;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

export async function authorizeSourceFile(input: SourceAuthorization): Promise<AuthorizedFile> {
  if (input.allowedRoots.length === 0) {
    throw new SessionContractError('SOURCE_NOT_AUTHORIZED', 'an explicitly selected allowed root is required');
  }
  const selected = resolve(input.selectedPath);
  const selectedStat = await safeLstat(selected);
  if (selectedStat.isSymbolicLink() && !input.allowSymlink) {
    throw new SessionContractError('SOURCE_SYMLINK', 'symbolic-link session sources are disabled');
  }
  const canonicalPath = await safeRealpath(selected);
  const roots = await Promise.all(input.allowedRoots.map(async (root) => ({
    input: root,
    canonical: await safeRealpath(resolve(root), true),
  })));
  const matchingRoot = roots.find(({ canonical }) => {
    const rel = relative(canonical, canonicalPath);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
  if (!matchingRoot) {
    throw new SessionContractError('SOURCE_OUTSIDE_ALLOWED_ROOT', 'source is outside the explicitly allowed roots');
  }
  const stat = await safeLstat(canonicalPath);
  if (!stat.isFile()) {
    throw new SessionContractError('SOURCE_NOT_REGULAR_FILE', 'session source must be a regular file');
  }
  if (input.maxBytes !== undefined && stat.size > input.maxBytes) {
    throw new SessionContractError('RESOURCE_LIMIT_EXCEEDED', 'session source exceeds the authorized byte limit', {
      limit: 'maxBytes', configured: input.maxBytes, observed: stat.size,
    });
  }
  return {
    canonicalPath,
    rootClass: matchingRoot.input,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    dev: stat.dev,
    ino: stat.ino,
  };
}

async function safeLstat(path: string): Promise<Stats> {
  try {
    return await lstat(path);
  } catch {
    throw new SessionContractError('SOURCE_NOT_AUTHORIZED', 'selected session source is inaccessible');
  }
}

async function safeRealpath(path: string, root = false): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new SessionContractError(
      'SOURCE_NOT_AUTHORIZED',
      root ? 'an authorized source root is inaccessible' : 'selected session source is inaccessible',
    );
  }
}

// Ambiguous token components are bounded; whitespace and key blocks use disjoint scans.
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['bearer-token', /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{12,}/gi],
  ['authorization', /\bAuthorization[ \t]*:[ \t]*[^\r\n]+/gi],
  ['cookie', /\b(?:Cookie|Set-Cookie)[ \t]*:[ \t]*[^\r\n]+/gi],
  ['environment-assignment', /\b(?:AWS_SECRET_ACCESS_KEY|[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY))[ \t]*=[ \t]*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s]+)/gi],
  ['credential', /\b(?:api[_-]?key|token|password|secret)[ \t]*[:=][ \t]*["']?[^\s"',;]{6,}/gi],
  ['credential', /^[ \t]*password[ \t]+[^\s]+[ \t]*$/gim],
  ['provider-token', /\b(?:sk-(?:ant-|proj-)?|[sr]k_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xai-|npm_|hf_|xox[baprs]-|AKIA|AIza)[A-Za-z0-9._~+/=-]{8,}/g],
  ['provider-token', /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/g],
  ['connection-string', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s]+/gi],
  ['credential-url', /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@[^\s]+/gi],
  ['fixture-credential', /\bredaction-canary-[A-Za-z0-9_-]+\b/gi],
  ['email', /\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}\b/gi],
];

function redactJwts(input: string, mark: (classification: string) => string): string {
  // Consume even incomplete candidates. Retrying at each inner `eyJ` in an
  // unterminated segment would repeatedly scan the remainder of a large record.
  return input.replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){0,2}/g, (candidate) => {
    const parts = candidate.split('.');
    return parts.length === 3 && parts[0].length >= 8 && parts[1].length >= 2 && parts[2].length >= 8
      ? mark('provider-token') : candidate;
  });
}

const PRIVATE_KEY_BEGIN = /-----BEGIN ((?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/g;

function redactPrivateKeys(input: string, mark: (classification: string) => string): string {
  const parts: string[] = [];
  let cursor = 0;
  PRIVATE_KEY_BEGIN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PRIVATE_KEY_BEGIN.exec(input))) {
    parts.push(input.slice(cursor, match.index), mark('private-key'));
    const endMarker = `-----END ${match[1]}-----`;
    const end = input.indexOf(endMarker, PRIVATE_KEY_BEGIN.lastIndex);
    // An unfinished key block is sensitive through the end of the record.
    cursor = end < 0 ? input.length : end + endMarker.length;
    PRIVATE_KEY_BEGIN.lastIndex = cursor;
  }
  parts.push(input.slice(cursor));
  return parts.join('');
}

const SENSITIVE_KEY = /(?:authorization|auth[_-]?header|cookie|credential|password|passwd|secret|token|api[_-]?key|private[_-]?key|connection[_-]?string)/i;
const CONTENT_KEY = /(?:^|[_-])(?:data|text|content|prompt|command|arguments?|args|result|output|body|request|response|source|code|query)(?:$|[_-])/i;
const PATH_KEY = /(?:^|[_-])(?:path|cwd|directory|filename|file)(?:$|[_-])/i;
const SAFE_STRING_KEY = /(?:^|[_-])(?:id|kind|type|role|status|state|lifecycle|reason|name|product|provider|version|schema|model|format|class|mode|event|operation|tool|method|language|scope|consistency|disposition|phase|visibility|protocol|category|classification|decision|capability|permission|transition|hash|digest)(?:$|[_-])/i;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export interface NativeSanitizationLimits {
  maxDepth: number;
  maxNodes: number;
  maxObjectKeys: number;
  maxArrayItems: number;
  maxStringBytes: number;
}

export interface NativeSanitizationResult {
  value: Record<string, unknown>;
  sensitivity: 'none' | 'sensitive';
  classes: string[];
  decisions: Record<string, number>;
}

const DEFAULT_NATIVE_LIMITS: NativeSanitizationLimits = {
  maxDepth: 8,
  maxNodes: 2_048,
  maxObjectKeys: 128,
  maxArrayItems: 256,
  maxStringBytes: 8 * 1024,
};

/**
 * Classify and sanitize provider-native attributes before they cross the
 * persistence boundary. Decisions contain counts only and are safe for audit.
 */
export function sanitizeNativeExtensions(
  input: unknown,
  overrides: Partial<NativeSanitizationLimits> = {},
): NativeSanitizationResult {
  const limits = { ...DEFAULT_NATIVE_LIMITS, ...overrides };
  const classes = new Set<string>();
  const decisions: Record<string, number> = {};
  const active = new WeakSet<object>();
  let nodes = 0;

  const marker = (classification: string): string => {
    classes.add(classification);
    decisions[classification] = (decisions[classification] ?? 0) + 1;
    return `[REDACTED:${classification}]`;
  };

  const visit = (value: unknown, key: string, depth: number): unknown => {
    const classifiedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1-$2');
    nodes += 1;
    if (nodes > limits.maxNodes) return marker('node-limit');
    if (depth > limits.maxDepth) return marker('depth-limit');
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string' && /^\[REDACTED:[a-z-]+\]$/.test(value)) return value;
    if (SENSITIVE_KEY.test(classifiedKey)) return marker('sensitive-field');
    if (CONTENT_KEY.test(classifiedKey)) return marker('content');
    if (PATH_KEY.test(classifiedKey)) return marker('path');
    if (typeof value === 'bigint') return String(value);
    if (typeof value !== 'string' && typeof value !== 'object') {
      return marker('unsupported-value');
    }
    if (typeof value === 'string') {
      if (Buffer.byteLength(value) > limits.maxStringBytes) return marker('string-limit');
      const redacted = redactSessionText(value);
      for (const classification of redacted.classes) classes.add(classification);
      for (const [classification, count] of Object.entries(redacted.decisions)) {
        decisions[classification] = (decisions[classification] ?? 0) + count;
      }
      if (redacted.classes.length) {
        decisions['classified-value'] = (decisions['classified-value'] ?? 0) + 1;
        return redacted.text.replace(CONTROL_CHARACTERS, ' ');
      }
      if (!SAFE_STRING_KEY.test(classifiedKey)) return marker('unclassified-field');
      return value.replace(/\r?\n/g, ' ').replace(CONTROL_CHARACTERS, ' ');
    }
    if (active.has(value)) return marker('circular-reference');
    active.add(value);
    try {
      if (Array.isArray(value)) {
        const selected = value.slice(0, limits.maxArrayItems)
          .map((entry) => visit(entry, key, depth + 1));
        if (value.length > limits.maxArrayItems) selected.push(marker('array-limit'));
        return selected;
      }
      const output: Record<string, unknown> = {};
      const entries = Object.entries(value as Record<string, unknown>);
      for (const [childKey, childValue] of entries.slice(0, limits.maxObjectKeys)) {
        const safeKey = redactSessionText(childKey);
        for (const classification of safeKey.classes) classes.add(classification);
        for (const [classification, count] of Object.entries(safeKey.decisions)) {
          decisions[classification] = (decisions[classification] ?? 0) + count;
        }
        Object.defineProperty(output, safeKey.text.replace(/\r?\n/g, ' ').replace(CONTROL_CHARACTERS, ''), {
          value: visit(childValue, childKey, depth + 1), enumerable: true, configurable: true, writable: true,
        });
      }
      if (entries.length > limits.maxObjectKeys) output.__truncated__ = marker('object-key-limit');
      return output;
    } finally {
      active.delete(value);
    }
  };

  const visited = visit(input ?? {}, 'extensions', 0);
  const value = visited && typeof visited === 'object' && !Array.isArray(visited)
    ? visited as Record<string, unknown>
    : { value: visited };
  return {
    value,
    sensitivity: classes.size ? 'sensitive' : 'none',
    classes: [...classes].sort(),
    decisions,
  };
}

export interface RedactionResult {
  text: string;
  sensitivity: 'none' | 'sensitive';
  classes: string[];
  decisions: Record<string, number>;
}

export function redactSessionText(input: string): RedactionResult {
  const decisions: Record<string, number> = {};
  const mark = (classification: string): string => {
    decisions[classification] = (decisions[classification] ?? 0) + 1;
    return `[REDACTED:${classification}]`;
  };
  let text = redactJwts(redactPrivateKeys(input, mark), mark);
  for (const [classification, pattern] of SECRET_PATTERNS) {
    text = text.replace(pattern, () => mark(classification));
  }
  const classes = Object.keys(decisions).sort();
  return { text, sensitivity: classes.length ? 'sensitive' : 'none', classes, decisions };
}

/** Redact every string, including object keys, without changing canonical field shapes. */
export function redactSessionValue<T>(input: T): {
  value: T; classes: string[]; decisions: Record<string, number>;
} {
  const decisions: Record<string, number> = {};
  const active = new WeakSet<object>();
  const text = (value: string): string => {
    const result = redactSessionText(value);
    for (const [key, count] of Object.entries(result.decisions)) {
      decisions[key] = (decisions[key] ?? 0) + count;
    }
    return result.text;
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return text(value);
    if (!value || typeof value !== 'object') return value;
    if (depth > 64 || active.has(value)) return '[REDACTED:structure-limit]';
    active.add(value);
    try {
      return Array.isArray(value)
        ? value.map((item) => visit(item, depth + 1))
        : Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key), visit(item, depth + 1)]));
    } finally {
      active.delete(value);
    }
  };
  const value = visit(input, 0) as T;
  return { value, classes: Object.keys(decisions).sort(), decisions };
}

/** Shared import boundary for canonical text, metadata and bounded native attributes. */
export function sanitizeSessionEvent(input: SessionEvent): SessionEvent {
  const native = sanitizeNativeExtensions(input.extensions);
  const result = redactSessionValue({ ...input, extensions: native.value });
  const event = result.value;
  const classes = [...new Set([...event.sensitivity.classes, ...native.classes, ...result.classes])].sort();
  event.sensitivity = {
    classification: classes.length ? 'sensitive' : 'none', classes,
  };
  // Counts contain classifications only, never matched input or excerpts.
  const prior = event.extensions['native.redaction'] as {
    decisions?: Array<{ classification: string; count: number }>;
  } | undefined;
  const counts: Record<string, number> = {};
  for (const item of Array.isArray(prior?.decisions) ? prior.decisions : []) {
    if (item && typeof item.classification === 'string' && Number.isSafeInteger(item.count) && item.count >= 0) {
      counts[item.classification] = item.count;
    }
  }
  for (const decisions of [native.decisions, result.decisions]) {
    for (const [key, count] of Object.entries(decisions)) {
      counts[key] = (counts[key] ?? 0) + count;
    }
  }
  event.extensions['native.redaction'] = {
    decisions: Object.entries(counts).map(([classification, count]) => ({ classification, count })),
  };
  return event;
}

export interface AuditEvent {
  operationId: string;
  operation: string;
  actor: string;
  counts: Record<string, number>;
  adapterVersion: string;
  policyVersion: string;
  outcome: 'committed' | 'failed' | 'preview';
  occurredAt: string;
}

export function contentFreeAuditEvent(event: AuditEvent): AuditEvent {
  return Object.freeze({ ...event, counts: { ...event.counts } });
}

export function requireNetworkConsent(operation: string, authorizedOperation?: string): void {
  if (authorizedOperation !== operation) {
    throw new SessionContractError('NETWORK_NOT_AUTHORIZED', `network operation requires explicit consent: ${operation}`);
  }
}

export interface ScopedSearchRecord {
  workspaceId: string;
  provider: string;
}

/** Apply authorization before a search implementation computes rank or snippets. */
export function prefilterAuthorizedSearchScope<T extends ScopedSearchRecord>(
  records: readonly T[],
  scope: { workspaceId: string; providers?: readonly string[] },
): T[] {
  const providers = scope.providers ? new Set(scope.providers) : null;
  return records.filter((record) =>
    record.workspaceId === scope.workspaceId
    && (providers === null || providers.has(record.provider)));
}
