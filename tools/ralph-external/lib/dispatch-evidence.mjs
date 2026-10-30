/**
 * S1 direct/shared dispatch evidence (#2891, epic #2875).
 *
 * Optional direct activity receipts, 08 brief/evidence storage discipline and
 * digest-only effect linkage for Tier 0 direct launches. Ordinary direct mode
 * works with receipts off: nothing here is a launch prerequisite and nothing
 * here creates a ledger, a receipt store or a second run-state machine.
 *
 * - Brief/evidence directories are mode 0700 and brief/result/evidence files
 *   0600, requested at creation time (0700/0600 carry no group/other bits,
 *   so no umask can grant wider access) and verified by fstat on the open
 *   fd. Files are created O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW: a pre-planted
 *   symlink or regular file fails instead of being followed or truncated.
 *   Directories are created one level at a time with mkdir 0700; an EEXIST
 *   entry is accepted only after an O_NOFOLLOW fd pins a real directory
 *   owned by us with mode exactly 0700.
 * - ONE fd-pinned primitive set is used everywhere a multi-step filesystem
 *   operation touches storage: a trusted directory is opened once with
 *   `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` and kept open for the whole
 *   operation; every child mkdir/open/unlink/read runs relative to that
 *   open descriptor via `/proc/self/fd/<fd>/<name>`, one path component at
 *   a time, each component itself opened `O_NOFOLLOW` and fstat-checked.
 *   No path string is ever re-resolved from scratch after a directory has
 *   been pinned, so an attacker who swaps a directory entry for a symlink
 *   between two of our steps cannot redirect the later step: our open file
 *   descriptor still refers to the original inode regardless of what the
 *   path now names. This defeats both "symlinked ancestor" attacks (the
 *   leaf's parent is swapped before the leaf is created) and "root swap"
 *   attacks (the operation's root is swapped mid-operation).
 * - CLI prompt files are removed only after a CONFIRMED stop with a recorded
 *   removable disposition, once the canonical redacted artifact is proven
 *   retained (well-formed digest of bytes that actually exist under the
 *   attempt root, verified through the same fd-pinned walk). Dirty/uncertain
 *   evidence is never deleted by these helpers.
 * - Disk-pressure admission reuses the #2954 resource-preflight gate
 *   (`checkWorkerDispatch`); this module only threads attempt roots through
 *   it, it does not duplicate the resolver.
 * - Usage confidence is enforced end to end through the #2890
 *   codec/validator (`workerUsage`): unknown stays unknown (null counts,
 *   never numerics), and every receipt usage validates before it is kept.
 * - Effect linkage is digest-only (`file.digest` targets over the exact
 *   artifact bytes, canonical relative paths); scopes and recovery verify
 *   through the EXISTING effect ledger, never a second ledger.
 * - Redacted export is an allowlist projection over explicitly named safe
 *   fields (ids, digests, statuses, usage with confidence). It never spreads
 *   the receipt, and every exported id/enum value is validated against a
 *   strict pattern or closed enum before it leaves the conductor: a value
 *   that fails validation is dropped and replaced with a fixed redaction
 *   marker rather than ever being written to the exported object.
 * - The invocation-ID pattern is defined once, in `src/effects/dispatch-
 *   verifier.ts`, and imported here (never duplicated as a second literal)
 *   through the repo's `tools/_resolve-impl.mjs` `importImpl` pattern, the
 *   same mechanism other `tools/` consumers of `src/` use (e.g.
 *   `tools/ralph-external/lib/provider-adapter.mjs`). Importing
 *   `src/*.js` directly from `tools/` fails under plain Node (only `.ts`
 *   exists under `src/`; the compiled output lives under `dist/src/`), so
 *   this module never does that.
 *
 * Managed (S2+) durability — required evidence, leases, activation and
 * runtime integration — is out of scope for this checkpoint.
 */

import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { importImpl } from '../../_resolve-impl.mjs';
import { checkWorkerDispatch } from '../../scripts/resource-preflight.mjs';
import { INVOCATION_PATTERN, DIGEST_PATTERN, TASK_ID_PATTERN, CHECK_ID_PATTERN,
  PROFILE_VERSION_PATTERN, IDENTITY_CONFIDENCE_VALUES, RECEIPT_TERMINATION_VALUES,
  REDACTION_MARKER, TERMINAL_OUTCOMES, USAGE_QUALITIES, DispatchEvidenceError, digestOf,
} from './dispatch-evidence-common.mjs';
import { openTraced, inside, fdChildRef } from './dispatch-evidence-storage.mjs';
export { DISPATCH_DIR_MODE, DISPATCH_FILE_MODE, DISPATCH_PROMPT_FILENAME, INVOCATION_PATTERN,
  DIGEST_PATTERN, TASK_ID_PATTERN, CHECK_ID_PATTERN, PROFILE_VERSION_PATTERN,
  IDENTITY_CONFIDENCE_VALUES, RECEIPT_TERMINATION_VALUES, REDACTION_MARKER,
  TERMINAL_OUTCOMES, USAGE_QUALITIES, DispatchEvidenceError } from './dispatch-evidence-common.mjs';
export { __raceTestHooks, requireArtifactRoot, ensureProtectedDir, writeProtectedFile,
  prepareDirectAttemptPaths, cleanupPromptFile } from './dispatch-evidence-storage.mjs';
const { O_NOFOLLOW, O_RDONLY } = constants;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
const { validateWorkerPayload } = await importImpl(import.meta.url, 'mission-protocol/codecs.js');

/**
 * Settle an attempt workspace without ever deleting uncertain work. Only
 * `completed` is removable on its outcome alone; `failed`, `cancelled` and
 * `timed-out` stay retained until the conductor records an explicit
 * disposition (a non-empty decision string, or a prior disposition object
 * with `removable: true`). `uncertain` (and any unknown outcome) always
 * refuses removal. The caller owns timed deletion of settled work; this
 * helper only classifies.
 */
export function settleAttemptDisposition(outcome, explicitDisposition = null) {
  if (outcome === 'uncertain' || !TERMINAL_OUTCOMES.includes(outcome)) {
    return { removable: false, reason: `retained: outcome ${String(outcome)} is uncertain or unknown` };
  }
  if (outcome === 'completed') {
    return { removable: true, reason: 'retention: sanitized completed evidence 30 days; clean workspace 24h after disposition' };
  }
  const recorded = (typeof explicitDisposition === 'string' && explicitDisposition.trim() !== '')
    || (explicitDisposition !== null && typeof explicitDisposition === 'object' && explicitDisposition.removable === true);
  if (recorded) {
    return { removable: true, reason: `retention: explicit conductor disposition releases ${outcome} work plus 7 days` };
  }
  return { removable: false, reason: `retained: outcome ${outcome} needs an explicit conductor disposition before removal` };
}

/**
 * True for every managed-or-direct attempt state the ledger can settle:
 * terminal execution or explicitly uncertain. Anything else (live, unknown,
 * missing) must not release capacity or accept work.
 */
export function isTerminalOrUncertain(execution) {
  const status = execution?.status;
  const termination = execution?.termination;
  if (status === 'uncertain' || termination === 'uncertain') return true;
  return ['completed', 'failed', 'cancelled', 'timed-out'].includes(status) && termination === 'confirmed';
}

// ---------------------------------------------------------------------------
// Optional direct activity receipts (06 §9). No receipt store, no ledger.
// ---------------------------------------------------------------------------

/**
 * Normalize one usage sample for receipts and export through the #2890
 * codec/validator (`workerUsage` in `src/mission-protocol/codecs.ts`): the
 * full eight-field shape is built here and validated there, so this helper
 * cannot drift from the shipped contract. Unknown quality carries null
 * counts — numerics with `unknown` are dropped, never preserved — and any
 * shape that still fails validation throws instead of entering a receipt.
 */
export function normalizeUsageForReceipt(usage) {
  const quality = USAGE_QUALITIES.includes(usage?.quality) ? usage.quality : 'unknown';
  const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
  const money = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
  const candidate = {
    inputTokens: count(usage?.inputTokens),
    outputTokens: count(usage?.outputTokens),
    cacheTokens: count(usage?.cacheTokens),
    reasoningTokens: count(usage?.reasoningTokens),
    costUsd: money(usage?.costUsd),
    quality,
    reservedTokens: count(usage?.reservedTokens) ?? 0,
    reservedUsd: money(usage?.reservedUsd),
  };
  if (candidate.quality === 'unknown') {
    candidate.inputTokens = null;
    candidate.outputTokens = null;
    candidate.cacheTokens = null;
    candidate.reasoningTokens = null;
    candidate.costUsd = null;
  }
  const { valid, errors } = validateWorkerPayload('workerUsage', candidate);
  if (!valid) {
    throw new DispatchEvidenceError(
      `Worker usage violates the #2890 contract: ${errors.join('; ') || 'shape mismatch'}`,
      'invalid-usage',
    );
  }
  return candidate;
}

/**
 * Build one optional direct activity receipt from conductor-held evidence.
 * Pure: returns the receipt object plus the single-line activity summary in
 * the current activity append format (`<operation> | <summary>` payload; the
 * caller timestamps and appends it with the existing activity-log path).
 *
 * Secrets never enter a receipt: only the command/tool descriptor digest is
 * recorded, never argv literals, env values or prompt text.
 */
export function buildDirectActivityReceipt({
  taskId,
  invocationId,
  transport,
  profileRef,
  profileVersion = null,
  commandDigest = null,
  toolDigest = null,
  requested = null,
  observed = null,
  identityConfidence = 'unavailable',
  worktree = null,
  baseRevision = null,
  handle = null,
  termination = 'uncertain',
  checks = [],
  acceptance = null,
  usage = null,
}, telemetry = null) {
  if (typeof taskId !== 'string' || !taskId) {
    throw new DispatchEvidenceError('Direct receipt needs a task ID', 'invalid-receipt');
  }
  if (typeof invocationId !== 'string' || !INVOCATION_PATTERN.test(invocationId)) {
    throw new DispatchEvidenceError('Direct receipt needs a valid invocation ID', 'invalid-receipt');
  }
  if (!['shell', 'mcp'].includes(transport)) {
    throw new DispatchEvidenceError('Direct receipt transport must be shell or mcp', 'invalid-receipt');
  }
  const descriptorDigest = commandDigest ?? toolDigest ?? null;
  if (descriptorDigest !== null && !DIGEST_PATTERN.test(descriptorDigest)) {
    throw new DispatchEvidenceError('Direct receipt carries a descriptor digest, never command text', 'invalid-receipt');
  }
  const receipt = {
    version: 1,
    mode: 'direct',
    taskId,
    invocationId,
    transport,
    ...(profileRef ? { profileRef } : {}),
    ...(profileVersion ? { profileVersion } : {}),
    ...(descriptorDigest ? { descriptorDigest } : {}),
    ...(requested ? { requested } : {}),
    ...(observed ? { observed } : {}),
    identityConfidence,
    ...(worktree ? { worktree } : {}),
    ...(baseRevision ? { baseRevision } : {}),
    ...(handle ? { handle } : {}),
    termination,
    checks: Array.isArray(checks) ? [...checks] : [],
    ...(acceptance ? { acceptance } : {}),
    usage: normalizeUsageForReceipt(usage),
  };
  const usageText = `${receipt.usage.quality}:in=${receipt.usage.inputTokens ?? 'unknown'}:out=${receipt.usage.outputTokens ?? 'unknown'}`;
  const summary = `direct worker ${transport} task=${taskId} attempt=${invocationId} `
    + `model=${observed?.model ?? requested?.model ?? 'unknown'} termination=${termination} usage=${usageText}`;
  // Optional observer consumes the completed receipt; it cannot own or change evidence.
  try { Promise.resolve(telemetry?.offer(receipt)).catch(() => {}); }
  catch { /* Projection failure never changes completion. */ }
  return { receipt, operation: 'create', summary };
}

/** `value` if it is a string matching `pattern`; the fixed redaction marker
 * if it is a non-empty string that FAILS the pattern; `undefined` (omit the
 * key) if it is absent entirely. A planted secret never survives in its own
 * value: it is replaced, not merely left out of an allowlist. */
function safeField(value, pattern) {
  if (typeof value !== 'string' || !value) return undefined;
  return pattern.test(value) ? value : REDACTION_MARKER;
}

/** Same contract as `safeField`, checked against a closed enum instead of a pattern. */
function safeEnum(value, allowed) {
  if (typeof value !== 'string' || !value) return undefined;
  return allowed.includes(value) ? value : REDACTION_MARKER;
}

/**
 * Redact a receipt for query/export as an ALLOWLIST projection over
 * explicitly named safe fields only: version/mode/task/invocation IDs,
 * transport, profile version, descriptor digest, identity confidence,
 * termination, per-check `{ checkId, exitCode }` pairs, and usage with
 * confidence. Nothing is spread: `requested`, `observed`, `acceptance`,
 * `worktree`, `handle`, `profileRef`, `baseRevision` and every other field —
 * including any caller-added top-level field — never leave the conductor.
 *
 * An allowlisted FIELD NAME is not an allowlisted VALUE: every id and enum
 * above is additionally validated against a strict pattern or closed enum
 * (`taskId`, `invocationId`, `profileVersion`, `identityConfidence`,
 * `termination`, `checks[].checkId`). A present-but-invalid value — for
 * example a secret planted where an id was expected — is dropped and
 * replaced with the fixed `REDACTION_MARKER`, never written through as-is.
 * Usage confidence is always retained: unknown stays unknown, never zero.
 */
export function redactReceiptForExport(receipt) {
  if (!receipt || typeof receipt !== 'object') {
    throw new DispatchEvidenceError('Export needs a receipt object', 'invalid-receipt');
  }
  const taskId = safeField(receipt.taskId, TASK_ID_PATTERN);
  const invocationId = safeField(receipt.invocationId, INVOCATION_PATTERN);
  const transport = receipt.transport === 'shell' || receipt.transport === 'mcp' ? receipt.transport : undefined;
  const profileVersion = safeField(receipt.profileVersion, PROFILE_VERSION_PATTERN);
  const descriptorDigest = typeof receipt.descriptorDigest === 'string' && DIGEST_PATTERN.test(receipt.descriptorDigest)
    ? receipt.descriptorDigest
    : undefined;
  const identityConfidence = safeEnum(receipt.identityConfidence, IDENTITY_CONFIDENCE_VALUES);
  const termination = safeEnum(receipt.termination, RECEIPT_TERMINATION_VALUES);
  const checks = Array.isArray(receipt.checks)
    ? receipt.checks.flatMap((check) => {
      if (!check || typeof check !== 'object') return [];
      const rawId = check.checkId;
      if (typeof rawId !== 'string' || !rawId) return [];
      const checkId = CHECK_ID_PATTERN.test(rawId) ? rawId : REDACTION_MARKER;
      if (check.exitCode !== null && check.exitCode !== undefined && !Number.isInteger(check.exitCode)) return [];
      return [{ checkId, exitCode: check.exitCode ?? null }];
    })
    : [];
  return {
    version: 1,
    mode: 'direct',
    ...(taskId ? { taskId } : {}),
    ...(invocationId ? { invocationId } : {}),
    ...(transport ? { transport } : {}),
    ...(profileVersion ? { profileVersion } : {}),
    ...(descriptorDigest ? { descriptorDigest } : {}),
    ...(identityConfidence ? { identityConfidence } : {}),
    ...(termination ? { termination } : {}),
    checks,
    usage: normalizeUsageForReceipt(receipt.usage),
    redacted: true,
  };
}

/**
 * Read one artifact file and return its `file.digest` effect target
 * (`file:<canonical-relative-path>@sha256:<hex>`) for a digest-only effect
 * link. Mirrors `src/effects/verifiers/file.ts`: the input is lexically
 * normalized against the root FIRST (pure string arithmetic — `.`/`..` are
 * resolved and an escaping result refuses before any filesystem access),
 * then the resulting in-bounds components are walked one at a time through
 * an fd-pinned root handle kept open for the whole operation: a symlinked
 * directory anywhere along the walk, or a symlinked leaf, refuses instead of
 * being followed, and no ancestor swap between any two steps can redirect a
 * later one. The emitted path is the canonical, walked relative path — never
 * the raw input spelling. Bytes are read through the final `O_NOFOLLOW` fd.
 */
export async function fileDigestTarget({ root, path: relativePath }) {
  if (typeof relativePath !== 'string' || !relativePath) {
    throw new DispatchEvidenceError('Effect link needs a relative artifact path', 'invalid-link');
  }
  if (typeof root !== 'string' || !root) {
    throw new DispatchEvidenceError('Effect link needs an evidence root', 'invalid-link');
  }
  const configuredRoot = resolve(root);
  const candidate = isAbsolute(relativePath) ? resolve(relativePath) : resolve(configuredRoot, relativePath);
  if (!inside(configuredRoot, candidate)) {
    throw new DispatchEvidenceError(`Effect link escapes the evidence root: ${String(relativePath)}`, 'link-escape');
  }
  const components = relative(configuredRoot, candidate).split(sep).filter((part) => part !== '');
  if (components.length === 0) {
    throw new DispatchEvidenceError(`Effect link escapes the evidence root: ${String(relativePath)}`, 'link-escape');
  }

  let rootHandle;
  try {
    rootHandle = await openTraced(configuredRoot, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (error) {
    throw new DispatchEvidenceError(
      `Effect link root is unavailable: ${configuredRoot} (${error?.code ?? error?.message ?? error})`,
      'storage-failure',
    );
  }
  try {
    let currentHandle = rootHandle;
    let ownsCurrent = false;
    try {
      for (let i = 0; i < components.length - 1; i += 1) {
        const ref = fdChildRef(currentHandle, components[i]);
        let next;
        try {
          next = await openTraced(ref, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        } catch (error) {
          if (error?.code === 'ELOOP') {
            throw new DispatchEvidenceError(`Effect link escapes the evidence root: ${String(relativePath)}`, 'link-escape');
          }
          throw new DispatchEvidenceError(
            `Effect link target is unreadable: ${components.join('/')} (${error?.code ?? error?.message ?? error})`,
            'storage-failure',
          );
        }
        if (ownsCurrent) await currentHandle.close();
        currentHandle = next;
        ownsCurrent = true;
      }
      const leaf = components[components.length - 1];
      const ref = fdChildRef(currentHandle, leaf);
      let fileHandle;
      try {
        fileHandle = await openTraced(ref, O_RDONLY | O_NOFOLLOW);
      } catch (error) {
        if (error?.code === 'ELOOP') {
          throw new DispatchEvidenceError(`Effect link escapes the evidence root: ${String(relativePath)}`, 'link-escape');
        }
        throw new DispatchEvidenceError(
          `Effect link target is unreadable: ${components.join('/')} (${error?.code ?? error?.message ?? error})`,
          'storage-failure',
        );
      }
      try {
        const stat = await fileHandle.stat();
        if (!stat.isFile()) {
          throw new DispatchEvidenceError(`Effect link target is not a regular file: ${String(relativePath)}`, 'invalid-link');
        }
        const bytes = await fileHandle.readFile();
        const digest = digestOf(bytes);
        return { target: `file:${components.join('/')}@${digest}`, digest };
      } finally {
        await fileHandle.close();
      }
    } finally {
      if (ownsCurrent) await currentHandle.close();
    }
  } finally {
    await rootHandle.close();
  }
}

/**
 * Build digest-only effect links for dispatch evidence: correlation IDs the
 * caller already holds plus `file.digest` targets over exact artifact bytes.
 * No raw content, no secrets, no second ledger — verification runs through
 * the existing effect ledger (`aiwg effect reconcile`).
 */
export function digestOnlyEffectLinks({ traceId = null, spanId = null, toolCallId = null, fileTargets = [] } = {}) {
  const links = {
    ...(traceId ? { traceId } : {}),
    ...(spanId ? { spanId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
  };
  const targets = [...fileTargets];
  for (const target of targets) {
    if (typeof target !== 'string' || !/^file:.+@sha256:[a-f0-9]{64}$/.test(target)) {
      throw new DispatchEvidenceError('Effect links carry file.digest targets only', 'invalid-link');
    }
  }
  return { links, fileTargets: targets };
}

/**
 * Disk-pressure admission for one attempt: the #2954 resource-preflight gate
 * sampling the filesystems of the actual attempt root and worktree — never
 * the conductor's process cwd. When no live signals are injected, the gate
 * samples exactly these caller-supplied paths; unknown or unprovable free
 * disk fails closed.
 */
export function checkDispatchAdmission({
  config,
  attemptRoot,
  worktree = null,
  live,
  readers,
  thresholdOverlay,
} = {}) {
  if (typeof attemptRoot !== 'string' || !attemptRoot) {
    throw new DispatchEvidenceError('Dispatch admission needs the attempt root', 'invalid-attempt-root');
  }
  const paths = [attemptRoot, ...(typeof worktree === 'string' && worktree ? [worktree] : [])];
  return checkWorkerDispatch({ config, live, readers, thresholdOverlay, paths });
}
